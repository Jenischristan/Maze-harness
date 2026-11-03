import type {
  ChatMessage,
  ChatProvider,
  ChatResult,
  ChatStreamEvent,
  ContentBlock,
  ToolCall,
  ToolDefinition,
  Usage
} from "../types.js";
import { estimateTokens, formatSummaryPrompt } from "../context/compaction.js";
import { CircuitBreaker, withRetry, isRetryableError } from "../util/retry.js";
import { redact } from "../util/redact.js";
import { modelInfo, type ModelInfo } from "./models.js";

export type WireProtocol = "chat-completions" | "anthropic-messages" | "openai-responses";

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;

  metaOverrides?: Partial<ModelInfo>;

  contextWindow?: number;

  protocol?: WireProtocol;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;

  retries?: number;
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;

  requestTimeoutMs?: number;

  thinking?: boolean | number;

  stream?: boolean;

  promptCache?: boolean;
}

export type OpenAICompatConfig = ProviderConfig;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
export { sleep as providerSleep };

function protocolFor(model: string, baseUrl: string, override?: WireProtocol): WireProtocol {
  if (override) return override;
  const info = modelInfo(model);
  if (info.provider === "anthropic") return "anthropic-messages";
  if (info.provider === "responses") return "openai-responses";

  if (/anthropic/.test(baseUrl)) return "anthropic-messages";
  return "chat-completions";
}

export function thinkingBody(
  model: string,
  thinking: boolean | number | undefined,
  baseUrl = ""
): Record<string, unknown> {
  if (thinking === undefined) return {};
  const info = modelInfo(model);
  const anthropic = info.provider === "anthropic" || /anthropic/.test(baseUrl);
  if (thinking === false) {
    if (anthropic) return { thinking: { type: "disabled" } };
    if (info.capabilities.reasoning) {
      return { reasoning: { effort: "minimal" } };
    }
    return { reasoning: { effort: "none" } };
  }
  const budget = typeof thinking === "number" ? Math.max(1024, Math.floor(thinking)) : 4096;
  if (anthropic) return { thinking: { type: "enabled", budget_tokens: budget } };
  const effort = budget >= 16_000 ? "high" : budget >= 4_000 ? "medium" : "low";
  return { reasoning: { effort } };
}

function headersFor(
  protocol: WireProtocol,
  apiKey: string | undefined,
  extra: Record<string, string> | undefined
): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    if (protocol === "anthropic-messages") {
      h["x-api-key"] = apiKey;
      h["anthropic-version"] = "2023-06-01";
    } else {
      h.authorization = `Bearer ${apiKey}`;
    }
  }
  return { ...h, ...(extra ?? {}) };
}

export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { __parseError: raw };
  }
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event = "";
  let dataLines: string[] = [];

  // Dispatch one complete SSE frame. `data:` lines are accumulated; a frame is
  // terminated by a blank line OR by end of stream, whichever comes first.
  const flush = (): { event: string; data: string } | null => {
    if (dataLines.length === 0) {
      event = "";
      return null;
    }
    const frame = { event, data: dataLines.join("\n") };
    event = "";
    dataLines = [];
    return frame;
  };

  const feedLine = (raw: string): { event: string; data: string } | null => {
    const line = raw.replace(/\r$/, "");
    if (line === "") return flush();
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }
    return null;
  };

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const frame = feedLine(line);
        if (frame) yield frame;
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    // A trailing line without a newline is still a valid final line, and any
    // pending data must be emitted rather than merged into the next frame.
    if (buffer.length > 0) {
      const frame = feedLine(buffer);
      if (frame) yield frame;
    }
    const tail = flush();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

interface ToolAccum {
  id: string;
  name: string;
  args: string;
}

export function finishToolCalls(acc: Map<number, ToolAccum>): ToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v], i) => ({
      id: v.id || `call-${i}-${Math.random().toString(36).slice(2, 8)}`,
      name: v.name || "unknown",
      arguments: parseToolArguments(v.args)
    }));
}

export type { ToolAccum };

export class NativeProvider implements ChatProvider {
  readonly model: string;
  readonly contextWindow: number;
  readonly info: ModelInfo;
  readonly protocol: WireProtocol;
  private readonly cfg: ProviderConfig;
  private readonly breaker = new CircuitBreaker(5, 30_000);

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    this.model = cfg.model;
    this.info = modelInfo(cfg.model, {
      ...(cfg.metaOverrides ?? {}),
      ...(cfg.contextWindow !== undefined ? { contextWindow: cfg.contextWindow } : {})
    });
    this.contextWindow = this.info.contextWindow;
    this.protocol = protocolFor(cfg.model, cfg.baseUrl, cfg.protocol);
  }

  private get promptCache(): boolean {
    return this.cfg.promptCache ?? this.info.capabilities.promptCache;
  }

  private headers(): Record<string, string> {
    return headersFor(this.protocol, this.cfg.apiKey, this.cfg.headers);
  }

  private endpoint(): string {
    const base = this.cfg.baseUrl.replace(/\/$/, "");
    if (this.protocol === "anthropic-messages") {
      if (/\/messages$/.test(base)) return base;
      if (/\/v1$/.test(base)) return `${base}/messages`;
      return `${base}/v1/messages`;
    }
    if (this.protocol === "openai-responses") {
      if (/\/responses$/.test(base)) return base;
      if (/\/v1$/.test(base)) return `${base}/responses`;
      return `${base}/v1/responses`;
    }
    if (/\/chat\/completions$/.test(base)) return base;
    if (/\/v1$/.test(base)) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  private async post(body: unknown, signal: AbortSignal | undefined): Promise<Response> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const requestTimeoutMs = this.cfg.requestTimeoutMs ?? 120_000;
    this.breaker.assertClosed();
    try {
      const res = await withRetry(
        async () => {
          const timeout = AbortSignal.timeout(requestTimeoutMs);
          const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
          let attempt: Response;
          try {
            attempt = await fetchImpl(this.endpoint(), {
              method: "POST",
              headers: this.headers(),
              body: JSON.stringify(body),
              signal: attemptSignal
            });
          } catch (err) {
            if (signal?.aborted) throw new Error("aborted");
            if (timeout.aborted) {
              throw Object.assign(new Error(`request timed out after ${requestTimeoutMs}ms`), {
                status: 408
              });
            }
            throw err;
          }
          if (attempt.ok) return attempt;
          const text = await attempt.text().catch(() => "");
          throw Object.assign(
            new Error(`provider ${attempt.status}: ${redact(text.slice(0, 500))}`),
            { status: attempt.status }
          );
        },
        {
          maxAttempts: this.cfg.retries ?? 6,
          baseDelayMs: this.cfg.retryBaseMs ?? 1500,
          maxDelayMs: 30_000,
          retryable: isRetryableError,
          signal
        }
      );
      this.breaker.recordSuccess();
      return res;
    } catch (err) {
      if (isRetryableError(err)) this.breaker.recordFailure();
      throw err;
    }
  }

  private hasImages(messages: ChatMessage[]): boolean {
    return messages.some((m) => m.contentBlocks?.some((b) => b.type === "image"));
  }

  private sampling(target: Record<string, unknown>): void {
    if (!this.info.capabilities.temperature) return;
    if (this.cfg.temperature !== undefined) target.temperature = this.cfg.temperature;
  }

  private bodyFor(messages: ChatMessage[], tools: ToolDefinition[]): Record<string, unknown> {
    if (this.protocol === "anthropic-messages") return this.anthropicBody(messages, tools);
    if (this.protocol === "openai-responses") return this.responsesBody(messages, tools);
    return this.chatCompletionsBody(messages, tools);
  }

  private chatCompletionsBody(
    messages: ChatMessage[],
    tools: ToolDefinition[]
  ): Record<string, unknown> {
    const wire = messages.map((m) => {
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) }
          }))
        };
      }
      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
      }
      if (m.role === "user" && m.contentBlocks && this.hasImages([m])) {
        return {
          role: "user",
          content: m.contentBlocks.map((b) =>
            b.type === "image"
              ? { type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } }
              : { type: "text", text: b.type === "text" ? b.text : "" }
          )
        };
      }
      return { role: m.role, content: m.content };
    });
    const body: Record<string, unknown> = { model: this.model, messages: wire };
    this.sampling(body);
    Object.assign(body, thinkingBody(this.model, this.cfg.thinking, this.cfg.baseUrl));
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
      body.tool_choice = "auto";
    }
    if (this.cfg.maxTokens) body.max_tokens = this.cfg.maxTokens;
    return body;
  }

  private anthropicBody(messages: ChatMessage[], tools: ToolDefinition[]): Record<string, unknown> {
    const systemParts: string[] = [];
    const out: Array<{ role: "user" | "assistant"; content: ContentBlock[] }> = [];
    const push = (role: "user" | "assistant", blocks: ContentBlock[]): void => {
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else out.push({ role, content: blocks });
    };
    for (const m of messages) {
      if (m.role === "system") {
        systemParts.push(m.content);
        continue;
      }
      if (m.role === "tool") {
        push("user", [{ type: "tool_result", toolUseId: m.toolCallId ?? "", content: m.content }]);
        continue;
      }
      if (m.role === "assistant") {
        const blocks: ContentBlock[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
        }
        if (blocks.length === 0) blocks.push({ type: "text", text: "" });
        push("assistant", blocks);
        continue;
      }
      if (m.contentBlocks && m.contentBlocks.length > 0) push("user", m.contentBlocks);
      else push("user", [{ type: "text", text: m.content }]);
    }

    const systemBlocks: ContentBlock[] = systemParts
      .filter((s) => s.trim())
      .map((s) => ({ type: "text", text: s }));
    if (this.promptCache && systemBlocks.length > 0) {
      (systemBlocks[systemBlocks.length - 1] as { cache_control?: unknown }).cache_control = {
        type: "ephemeral"
      };
    }
    if (this.promptCache && out.length > 0) {
      const last = out[out.length - 1]!;
      const tail = last.content[last.content.length - 1];
      if (tail && (tail.type === "text" || tail.type === "tool_result")) {
        (tail as { cache_control?: unknown }).cache_control = { type: "ephemeral" };
      }
    }
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.cfg.maxTokens ?? this.info.maxOutputTokens,
      messages: out
    };
    if (systemBlocks.length > 0) body.system = systemBlocks;
    this.sampling(body);
    Object.assign(body, thinkingBody(this.model, this.cfg.thinking, this.cfg.baseUrl));
    if (tools.length > 0) {
      const wireTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      })) as Array<Record<string, unknown>>;
      if (this.promptCache) {
        const lastTool = wireTools[wireTools.length - 1];
        if (lastTool) lastTool.cache_control = { type: "ephemeral" };
      }
      body.tools = wireTools;
    }
    return body;
  }

  private responsesBody(messages: ChatMessage[], tools: ToolDefinition[]): Record<string, unknown> {
    const input: unknown[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        input.push({ role: "system", content: m.content });
      } else if (m.role === "user") {
        if (m.contentBlocks && this.hasImages([m])) {
          input.push({
            role: "user",
            content: m.contentBlocks.map((b) =>
              b.type === "image"
                ? { type: "input_image", image_url: `data:${b.mediaType};base64,${b.data}` }
                : { type: "input_text", text: b.type === "text" ? b.text : "" }
            )
          });
        } else {
          input.push({ role: "user", content: m.content });
        }
      } else if (m.role === "assistant") {
        if (m.content) input.push({ role: "assistant", content: m.content });
        for (const c of m.toolCalls ?? []) {
          input.push({
            type: "function_call",
            call_id: c.id,
            name: c.name,
            arguments: JSON.stringify(c.arguments)
          });
        }
      } else if (m.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: m.toolCallId ?? "",
          output: m.content
        });
      }
    }
    const body: Record<string, unknown> = { model: this.model, input };
    this.sampling(body);
    Object.assign(body, thinkingBody(this.model, this.cfg.thinking, this.cfg.baseUrl));
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }));
      body.tool_choice = "auto";
    }
    if (this.cfg.maxTokens) body.max_output_tokens = this.cfg.maxTokens;
    return body;
  }

  private parseNonStreaming(data: unknown): ChatResult {
    if (this.protocol === "anthropic-messages") return this.parseAnthropicResponse(data);
    if (this.protocol === "openai-responses") return this.parseResponsesResponse(data);
    return this.parseChatCompletionsResponse(data);
  }

  private parseChatCompletionsResponse(data: unknown): ChatResult {
    const d = data as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string;
          reasoning?: string;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const choice = d.choices?.[0];
    const msg = choice?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? `call-${i}-${Math.random().toString(36).slice(2, 8)}`,
      name: c.function?.name ?? "unknown",
      arguments: parseToolArguments(c.function?.arguments)
    }));
    const usage: Usage = {
      promptTokens: d.usage?.prompt_tokens ?? 0,
      completionTokens: d.usage?.completion_tokens ?? 0,
      totalTokens:
        d.usage?.total_tokens ?? (d.usage?.prompt_tokens ?? 0) + (d.usage?.completion_tokens ?? 0),
      cacheReadTokens: d.usage?.prompt_tokens_details?.cached_tokens,
      reasoningTokens: d.usage?.completion_tokens_details?.reasoning_tokens
    };
    return this.finishResult(
      msg.content ?? "",
      toolCalls,
      usage,
      choice?.finish_reason,
      msg.reasoning_content ?? msg.reasoning
    );
  }

  private parseAnthropicResponse(data: unknown): ChatResult {
    const d = data as {
      content?: Array<{
        type?: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      stop_reason?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    let text = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    for (const block of d.content ?? []) {
      if (block.type === "text") text += block.text ?? "";
      else if (block.type === "thinking") reasoning += block.thinking ?? "";
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id ?? `call-${toolCalls.length}`,
          name: block.name ?? "unknown",
          arguments: block.input ?? {}
        });
      }
    }
    const prompt = d.usage?.input_tokens ?? 0;
    const completion = d.usage?.output_tokens ?? 0;
    const usage: Usage = {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      cacheReadTokens: d.usage?.cache_read_input_tokens,
      cacheWriteTokens: d.usage?.cache_creation_input_tokens
    };
    const stop =
      d.stop_reason === "tool_use"
        ? "tool_calls"
        : d.stop_reason === "max_tokens"
          ? "length"
          : "stop";
    return this.finishResult(text, toolCalls, usage, stop, reasoning);
  }

  private parseResponsesResponse(data: unknown): ChatResult {
    const d = data as {
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
        call_id?: string;
        name?: string;
        arguments?: string;
        summary?: Array<{ type?: string; text?: string }>;
      }>;
      status?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
        output_tokens_details?: { reasoning_tokens?: number };
      };
    };
    let text = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];
    for (const item of d.output ?? []) {
      if (item.type === "reasoning") {
        for (const s of item.summary ?? []) reasoning += s.text ?? "";
      } else if (item.type === "message") {
        for (const c of item.content ?? []) if (c.type === "output_text") text += c.text ?? "";
      } else if (item.type === "function_call") {
        toolCalls.push({
          id: item.call_id ?? `call-${toolCalls.length}`,
          name: item.name ?? "unknown",
          arguments: parseToolArguments(item.arguments)
        });
      }
    }
    const prompt = d.usage?.input_tokens ?? 0;
    const completion = d.usage?.output_tokens ?? 0;
    const usage: Usage = {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      cacheReadTokens: d.usage?.input_tokens_details?.cached_tokens,
      reasoningTokens: d.usage?.output_tokens_details?.reasoning_tokens
    };
    return this.finishResult(
      text,
      toolCalls,
      usage,
      d.status === "incomplete" ? "length" : undefined,
      reasoning
    );
  }

  private finishResult(
    content: string,
    toolCalls: ToolCall[],
    usage: Usage,
    finish: string | undefined,
    reasoning?: string
  ): ChatResult {
    const stopReason: ChatResult["stopReason"] =
      toolCalls.length > 0
        ? "tool_calls"
        : finish === "length" || finish === "max_tokens"
          ? "length"
          : "stop";
    return {
      message: {
        role: "assistant",
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        tokens: usage.completionTokens,
        reasoning: reasoning && reasoning.trim() ? reasoning : undefined
      },
      usage,
      stopReason
    };
  }

  async complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const res = await this.post(this.bodyFor(messages, tools), signal);
    return this.parseNonStreaming(await res.json());
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncGenerator<ChatStreamEvent> {
    const body = this.bodyFor(messages, tools);
    body.stream = true;
    const res = await this.post(body, signal);
    if (!res.body) {
      const parsed = this.parseNonStreaming(await res.json());
      if (parsed.message.content) yield { type: "text", delta: parsed.message.content };
      for (const call of parsed.message.toolCalls ?? []) yield { type: "tool_call", call };
      yield { type: "usage", usage: parsed.usage };
      yield { type: "stop", stopReason: parsed.stopReason };
      return;
    }
    const acc = new Map<number, ToolAccum>();
    const started = new Set<number>();
    let finishReason: string | undefined;
    let sawToolCall = false;
    let usage: Usage | undefined;
    let text = "";

    for await (const { event, data } of parseSse(res.body, signal)) {
      if (data === "[DONE]") break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      for (const d of this.streamDeltas(event, parsed, acc, started)) {
        if (d.type === "text") {
          text += d.delta;
          yield d;
        } else if (d.type === "tool_start") {
          sawToolCall = true;
          yield d;
        } else if (d.type === "usage") {
          usage = d.usage;
        } else if (d.type === "stop") {
          finishReason = d.stopReason;
          if (d.stopReason !== "error") yield d;
        } else {
          yield d;
        }
      }
    }

    for (const call of finishToolCalls(acc)) yield { type: "tool_call", call };
    const finalUsage: Usage = usage ?? {
      promptTokens: messages.reduce((n, m) => n + estimateTokens(m.content ?? ""), 0),
      completionTokens: estimateTokens(text),
      totalTokens: 0
    };
    yield { type: "usage", usage: finalUsage };
    const stopReason: ChatResult["stopReason"] = sawToolCall
      ? "tool_calls"
      : finishReason === "length"
        ? "length"
        : "stop";
    yield { type: "stop", stopReason };
  }

  private streamDeltas(
    event: string,
    parsed: unknown,
    acc: Map<number, ToolAccum>,
    started: Set<number>
  ): ChatStreamEvent[] {
    const out: ChatStreamEvent[] = [];
    if (this.protocol === "anthropic-messages") {
      const d = parsed as {
        type?: string;
        index?: number;
        delta?: {
          type?: string;
          text?: string;
          thinking?: string;
          partial_json?: string;
          stop_reason?: string;
        };
        content_block?: { type?: string; id?: string; name?: string };
        usage?: { output_tokens?: number; input_tokens?: number };
      };
      if (d.type === "content_block_start" && d.content_block?.type === "tool_use") {
        const index = d.index ?? 0;
        acc.set(index, {
          id: d.content_block.id ?? "",
          name: d.content_block.name ?? "",
          args: ""
        });
        started.add(index);
        out.push({
          type: "tool_start",
          index,
          id: d.content_block.id ?? "",
          name: d.content_block.name ?? ""
        });
      } else if (d.type === "content_block_delta") {
        if (d.delta?.type === "text_delta" && d.delta.text) {
          out.push({ type: "text", delta: d.delta.text });
        } else if (d.delta?.type === "thinking_delta" && d.delta.thinking) {
          out.push({ type: "reasoning", delta: d.delta.thinking });
        } else if (d.delta?.type === "input_json_delta" && d.delta.partial_json) {
          const index = d.index ?? 0;
          const a = acc.get(index);
          if (a) a.args += d.delta.partial_json;
          out.push({ type: "tool_delta", index, delta: d.delta.partial_json });
        }
      } else if (d.type === "message_delta") {
        if (d.delta?.stop_reason) {
          out.push({
            type: "stop",
            stopReason:
              d.delta.stop_reason === "tool_use"
                ? "tool_calls"
                : d.delta.stop_reason === "max_tokens"
                  ? "length"
                  : "stop"
          });
        }
        if (d.usage) {
          const prompt = d.usage.input_tokens ?? 0;
          const completion = d.usage.output_tokens ?? 0;
          out.push({
            type: "usage",
            usage: {
              promptTokens: prompt,
              completionTokens: completion,
              totalTokens: prompt + completion
            }
          });
        }
      }
      void event;
      return out;
    }

    if (this.protocol === "openai-responses") {
      const d = parsed as {
        type?: string;
        delta?: string;
        output_index?: number;
        item?: { type?: string; call_id?: string; name?: string };
        response?: {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            input_tokens_details?: { cached_tokens?: number };
          };
          status?: string;
        };
      };
      if (d.type === "response.output_text.delta" && d.delta) {
        out.push({ type: "text", delta: d.delta });
      } else if (
        (d.type === "response.reasoning_summary_text.delta" ||
          d.type === "response.reasoning_text.delta") &&
        d.delta
      ) {
        out.push({ type: "reasoning", delta: d.delta });
      } else if (d.type === "response.output_item.added" && d.item?.type === "function_call") {
        const index = d.output_index ?? 0;
        acc.set(index, { id: d.item.call_id ?? "", name: d.item.name ?? "", args: "" });
        started.add(index);
        out.push({ type: "tool_start", index, id: d.item.call_id ?? "", name: d.item.name ?? "" });
      } else if (d.type === "response.function_call_arguments.delta" && d.delta) {
        const index = d.output_index ?? 0;
        const a = acc.get(index);
        if (a) a.args += d.delta;
        out.push({ type: "tool_delta", index, delta: d.delta });
      } else if (d.type === "response.completed" && d.response?.usage) {
        const prompt = d.response.usage.input_tokens ?? 0;
        const completion = d.response.usage.output_tokens ?? 0;
        out.push({
          type: "usage",
          usage: {
            promptTokens: prompt,
            completionTokens: completion,
            totalTokens: prompt + completion,
            cacheReadTokens: d.response.usage.input_tokens_details?.cached_tokens
          }
        });
      } else if (d.type === "response.incomplete") {
        out.push({ type: "stop", stopReason: "length" });
      }
      return out;
    }

    const d = parsed as {
      choices?: Array<{
        delta?: {
          content?: string | null;
          reasoning_content?: string;
          reasoning?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const choice = d.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content) out.push({ type: "text", delta: delta.content });
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (reasoning) out.push({ type: "reasoning", delta: reasoning });
    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? 0;
      if (tc.id || tc.function?.name) {
        const existing = acc.get(index);
        if (!existing || !started.has(index)) {
          acc.set(index, {
            id: tc.id ?? existing?.id ?? "",
            name: tc.function?.name ?? existing?.name ?? "",
            args: existing?.args ?? ""
          });
          started.add(index);
          out.push({
            type: "tool_start",
            index,
            id: tc.id ?? "",
            name: tc.function?.name ?? ""
          });
        } else if (tc.function?.name) {
          existing.name = tc.function.name;
        }
      }
      const fragment = tc.function?.arguments;
      if (typeof fragment === "string" && fragment.length > 0) {
        const a = acc.get(index);
        if (a) a.args += fragment;
        out.push({ type: "tool_delta", index, delta: fragment });
      }
    }
    if (choice?.finish_reason) {
      out.push({
        type: "stop",
        stopReason:
          choice.finish_reason === "tool_calls"
            ? "tool_calls"
            : choice.finish_reason === "length"
              ? "length"
              : "stop"
      });
    }
    if (d.usage) {
      const prompt = d.usage.prompt_tokens ?? 0;
      const completion = d.usage.completion_tokens ?? 0;
      out.push({
        type: "usage",
        usage: {
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: prompt + completion,
          cacheReadTokens: d.usage.prompt_tokens_details?.cached_tokens
        }
      });
    }
    return out;
  }

  async summarize(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const prompt = formatSummaryPrompt(messages);
    const body = this.bodyFor([{ role: "user", content: prompt }], []);

    delete body.tools;
    delete body.tool_choice;
    const res = await this.post(body, signal);
    return this.parseNonStreaming(await res.json()).message.content || "(summary unavailable)";
  }
}

export async function collectStream(
  provider: ChatProvider,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  opts: {
    signal?: AbortSignal;
    onEvent?: (event: ChatStreamEvent) => void;
  } = {}
): Promise<ChatResult> {
  if (!provider.stream) return provider.complete(messages, tools, opts.signal);
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let stopReason: ChatResult["stopReason"] = "stop";
  for await (const event of provider.stream(messages, tools, opts.signal)) {
    opts.onEvent?.(event);
    if (event.type === "text") text += event.delta;
    else if (event.type === "reasoning") reasoning += event.delta;
    else if (event.type === "tool_call") toolCalls.push(event.call);
    else if (event.type === "usage") usage = event.usage;
    else if (event.type === "stop") stopReason = event.stopReason;
  }
  return {
    message: {
      role: "assistant",
      content: text,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokens: usage.completionTokens,
      reasoning: reasoning || undefined
    },
    usage,
    stopReason: toolCalls.length > 0 ? "tool_calls" : stopReason
  };
}

export { NativeProvider as OpenAICompatProvider };

export class ScriptedProvider implements ChatProvider {
  readonly model: string;
  readonly contextWindow: number;
  readonly info: ModelInfo;
  private readonly turns: ChatResult[];
  private index = 0;

  constructor(opts: { model?: string; contextWindow?: number; turns?: ChatResult[] } = {}) {
    this.model = opts.model ?? "scripted";
    this.info = modelInfo(this.model, {
      contextWindow: opts.contextWindow ?? 32_000,
      capabilities: {
        tools: true,
        streaming: false,
        reasoning: false,
        temperature: true,
        promptCache: false,
        reasoningContent: false,
        images: false,
        pdf: false
      }
    });
    this.contextWindow = this.info.contextWindow;
    this.turns = opts.turns ?? [];
  }

  async complete(messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ChatResult> {
    const next = this.turns[this.index];
    if (next) {
      this.index += 1;
      return next;
    }
    const last = messages[messages.length - 1];
    const promptTokens = messages.reduce((n, m) => n + estimateTokens(m.content ?? ""), 0);
    const completionTokens = 16;
    return {
      message: {
        role: "assistant",
        content: `scripted reply (${messages.length} messages, last role=${last?.role ?? "none"})`
      },
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      },
      stopReason: "stop"
    };
  }

  async summarize(messages: ChatMessage[]): Promise<string> {
    const files = new Set<string>();
    const commands: string[] = [];
    for (const m of messages) {
      if (m.role === "tool" && m.name) files.add(m.name);
      if (m.role === "assistant") {
        for (const c of m.toolCalls ?? []) {
          if (c.name === "bash" && typeof c.arguments.command === "string") {
            commands.push(c.arguments.command);
          }
        }
      }
    }
    return [
      `Summarized ${messages.length} messages.`,
      files.size > 0 ? `Tools used: ${[...files].join(", ")}.` : "",
      commands.length > 0 ? `Commands: ${commands.slice(-5).join("; ")}.` : ""
    ]
      .filter(Boolean)
      .join(" ");
  }
}

export interface ProviderSpec {
  kind: "openai" | "scripted" | "anthropic" | "responses";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  contextWindow?: number;
  thinking?: boolean | number;
  maxTokens?: number;
}

export function makeProvider(spec: ProviderSpec): ChatProvider {
  if (spec.kind === "scripted") {
    return new ScriptedProvider({ model: spec.model, contextWindow: spec.contextWindow });
  }
  const protocol: WireProtocol | undefined =
    spec.kind === "anthropic"
      ? "anthropic-messages"
      : spec.kind === "responses"
        ? "openai-responses"
        : undefined;
  return new NativeProvider({
    baseUrl:
      spec.baseUrl ?? process.env.DREAM_BASE_URL ?? "http://127.0.0.1:8788/v1/chat/completions",
    apiKey: spec.apiKey ?? process.env.DREAM_API_KEY ?? process.env.DEEPSEEK_ROUTER_KEY,
    model: spec.model ?? process.env.DREAM_AGENT_MODEL ?? "deepseek-chat",
    contextWindow: spec.contextWindow,
    protocol,
    thinking: spec.thinking,
    maxTokens: spec.maxTokens
  });
}

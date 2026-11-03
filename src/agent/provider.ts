import type {
  ChatMessage,
  ChatProvider,
  ChatResult,
  ToolCall,
  ToolDefinition,
  Usage
} from "../types.js";
import { estimateTokens, formatSummaryPrompt } from "../context/compaction.js";
import { CircuitBreaker, withRetry, isRetryableError } from "../util/retry.js";
import { redact } from "../util/redact.js";

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  contextWindow?: number;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  /** Retries for transient failures (429/5xx/network). */
  retries?: number;
  retryBaseMs?: number;
  fetchImpl?: typeof fetch;
  /** Per-request deadline in ms (default 120000). */
  requestTimeoutMs?: number;
  /**
   * Extended-thinking / reasoning budget. `false` disables it, a number is a
   * token budget (Anthropic-style `thinking.budget_tokens`), and `true` asks
   * for the provider's default. Translated per-vendor in `thinkingBody`.
   */
  thinking?: boolean | number;
}

interface ChatCompletionToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionMessage {
  role?: string;
  content?: string | null;
  tool_calls?: ChatCompletionToolCall[];
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: ChatCompletionMessage;
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/** Sleep, but resolve early when the caller aborts. */
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

/**
 * Translate the harness-level thinking setting into the request fields the
 * target API understands.
 *
 * - DeepSeek: `deepseek-reasoner` reasons by default; other models opt in with
 *   `thinking: { type: "enabled" }`. Disabling uses `{ type: "disabled" }`.
 * - Anthropic-compatible gateways: `thinking: { type: "enabled", budget_tokens }`.
 * - OpenRouter / generic OpenAI-compatible: `reasoning: { effort }`.
 *
 * Returning `{}` leaves the request untouched, so the default path is
 * byte-identical to before this option existed.
 */
export function thinkingBody(
  model: string,
  thinking: boolean | number | undefined,
  baseUrl = ""
): Record<string, unknown> {
  if (thinking === undefined) return {};
  const m = model.toLowerCase();
  const anthropic = /anthropic|claude/.test(m) || /anthropic/.test(baseUrl);
  if (thinking === false) {
    if (anthropic) return { thinking: { type: "disabled" } };
    if (/deepseek/.test(m)) return { thinking: { type: "disabled" } };
    return { reasoning: { effort: "none" } };
  }
  const budget = typeof thinking === "number" ? Math.max(1024, Math.floor(thinking)) : 4096;
  if (anthropic) return { thinking: { type: "enabled", budget_tokens: budget } };
  if (/deepseek/.test(m)) return { thinking: { type: "enabled" } };
  const effort = budget >= 16_000 ? "high" : budget >= 4_000 ? "medium" : "low";
  return { reasoning: { effort } };
}

function jitter(ms: number): number {
  return Math.round(ms * (0.7 + Math.random() * 0.6));
}

/**
 * Generic OpenAI-compatible chat provider. Works with OpenAI, DeepSeek,
 * OpenRouter, vLLM, llama.cpp, and local routers.
 */
export class OpenAICompatProvider implements ChatProvider {
  readonly model: string;
  readonly contextWindow: number;
  private readonly cfg: OpenAICompatConfig;
  /** Opens after repeated transient failures so a dead endpoint fails fast. */
  private readonly breaker = new CircuitBreaker(5, 30_000);

  constructor(cfg: OpenAICompatConfig) {
    this.cfg = cfg;
    this.model = cfg.model;
    this.contextWindow = cfg.contextWindow ?? 128_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`;
    return { ...h, ...(this.cfg.headers ?? {}) };
  }

  private toWire(
    messages: ChatMessage[],
    tools?: ToolDefinition[]
  ): { messages: unknown[]; tools?: unknown[] } {
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
      return { role: m.role, content: m.content };
    });
    const out: { messages: unknown[]; tools?: unknown[] } = { messages: wire };
    if (tools && tools.length > 0) {
      out.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
    }
    return out;
  }

  /**
   * POST once, then retry through the shared policy.
   *
   * The old loop hard-coded its own retryable-status list, had no configurable
   * budget and no circuit breaker, and formatted a raw provider body into the
   * error (which could echo an Authorization header). Retries now share one
   * policy with jitter, a bounded budget, and a breaker; the error text is
   * redacted and status-tagged so `isRetryableError` can classify it.
   */
  private async post(body: unknown, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const requestTimeoutMs = this.cfg.requestTimeoutMs ?? 120_000;
    this.breaker.assertClosed();
    try {
      const data = await withRetry(
        async () => {
          // Per-attempt deadline so a socket that is accepted but never
          // responds cannot hang the loop forever.
          const timeout = AbortSignal.timeout(requestTimeoutMs);
          const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
          let res: Response;
          try {
            res = await fetchImpl(this.cfg.baseUrl, {
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
          if (res.ok) return (await res.json()) as ChatCompletionResponse;
          const text = await res.text().catch(() => "");
          throw Object.assign(new Error(`provider ${res.status}: ${redact(text.slice(0, 500))}`), {
            status: res.status
          });
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
      return data;
    } catch (err) {
      // Only count transient failures toward the breaker; a 400 is a caller bug
      // and must not open the circuit for a healthy endpoint.
      if (isRetryableError(err)) this.breaker.recordFailure();
      throw err;
    }
  }

  async complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const { messages: wire, tools: wireTools } = this.toWire(messages, tools);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: wire,
      temperature: this.cfg.temperature ?? 0.2
    };
    Object.assign(body, thinkingBody(this.model, this.cfg.thinking, this.cfg.baseUrl));
    if (wireTools) {
      body.tools = wireTools;
      body.tool_choice = "auto";
    }
    if (this.cfg.maxTokens) body.max_tokens = this.cfg.maxTokens;
    const data = await this.post(body, signal);
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c, i) => {
      let args: Record<string, unknown> = {};
      const raw = c.function?.arguments;
      if (typeof raw === "string" && raw.trim().length > 0) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          } else {
            args = { value: parsed };
          }
        } catch {
          args = { __parseError: raw };
        }
      }
      return {
        id: c.id ?? `call-${i}-${Math.random().toString(36).slice(2, 8)}`,
        name: c.function?.name ?? "unknown",
        arguments: args
      };
    });
    const usage: Usage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens:
        data.usage?.total_tokens ??
        (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0)
    };
    const finish = choice?.finish_reason;
    const stopReason: ChatResult["stopReason"] =
      toolCalls.length > 0 ? "tool_calls" : finish === "length" ? "length" : "stop";
    return {
      message: {
        role: "assistant",
        content: msg.content ?? "",
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        tokens: usage.completionTokens
      },
      usage,
      stopReason
    };
  }

  async summarize(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const prompt = formatSummaryPrompt(messages);
    const body = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    };
    const data = await this.post(body, signal);
    return data.choices?.[0]?.message?.content ?? "(summary unavailable)";
  }
}

/**
 * Deterministic offline provider for tests and dry runs. It never calls the
 * network. Scripted turns are consumed in order; when exhausted it summarizes
 * what it has seen.
 */
export class ScriptedProvider implements ChatProvider {
  readonly model: string;
  readonly contextWindow: number;
  private readonly turns: ChatResult[];
  private index = 0;

  constructor(opts: { model?: string; contextWindow?: number; turns?: ChatResult[] } = {}) {
    this.model = opts.model ?? "scripted";
    this.contextWindow = opts.contextWindow ?? 32_000;
    this.turns = opts.turns ?? [];
  }

  async complete(messages: ChatMessage[], _tools: ToolDefinition[]): Promise<ChatResult> {
    const next = this.turns[this.index];
    if (next) {
      this.index += 1;
      return next;
    }
    const last = messages[messages.length - 1];
    return {
      message: {
        role: "assistant",
        content: `scripted reply (${messages.length} messages, last role=${last?.role ?? "none"})`
      },
      usage: {
        promptTokens: messages.reduce((n, m) => n + estimateTokens(m.content ?? ""), 0),
        completionTokens: 16,
        totalTokens: 0
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
          if (c.name === "bash" && typeof c.arguments.command === "string")
            commands.push(c.arguments.command);
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
  kind: "openai" | "scripted";
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  contextWindow?: number;
}

export function makeProvider(spec: ProviderSpec): ChatProvider {
  if (spec.kind === "scripted") return new ScriptedProvider({ model: spec.model });
  return new OpenAICompatProvider({
    baseUrl:
      spec.baseUrl ?? process.env.DREAM_BASE_URL ?? "http://127.0.0.1:8788/v1/chat/completions",
    apiKey: spec.apiKey ?? process.env.DREAM_API_KEY ?? process.env.DEEPSEEK_ROUTER_KEY,
    model: spec.model ?? process.env.DREAM_AGENT_MODEL ?? "deepseek-chat",
    contextWindow: spec.contextWindow
  });
}

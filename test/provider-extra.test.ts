import { describe, expect, it } from "vitest";
import {
  NativeProvider,
  ScriptedProvider,
  collectStream,
  finishToolCalls,
  makeProvider,
  parseSse,
  parseToolArguments,
  providerSleep,
  thinkingBody
} from "../src/agent/provider.js";
import type { ChatMessage, ToolDefinition } from "../src/types.js";

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    }
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const noTools: ToolDefinition[] = [];

function makeEndpoint(baseUrl: string, model: string): string {
  const p = new NativeProvider({ baseUrl, model });
  return (p as unknown as { endpoint(): string }).endpoint();
}

describe("provider: protocol selection and bodies", () => {
  it("picks the wire protocol from the model, then the base url", () => {
    expect(new NativeProvider({ baseUrl: "http://x", model: "claude-sonnet-4" }).protocol).toBe(
      "anthropic-messages"
    );
    expect(new NativeProvider({ baseUrl: "http://x", model: "gpt-5" }).protocol).toBe(
      "openai-responses"
    );
    expect(
      new NativeProvider({ baseUrl: "http://anthropic-proxy", model: "mystery" }).protocol
    ).toBe("anthropic-messages");
    expect(
      new NativeProvider({
        baseUrl: "http://x",
        model: "claude-sonnet-4",
        protocol: "chat-completions"
      }).protocol
    ).toBe("chat-completions");
  });

  it("builds endpoint urls without duplicating suffixes", () => {
    expect(makeEndpoint("http://x", "deepseek-chat")).toBe("http://x/v1/chat/completions");
    expect(makeEndpoint("http://x/v1", "deepseek-chat")).toBe("http://x/v1/chat/completions");
    expect(makeEndpoint("http://x/v1/chat/completions", "deepseek-chat")).toBe(
      "http://x/v1/chat/completions"
    );
    expect(makeEndpoint("http://x", "claude-sonnet-4")).toBe("http://x/v1/messages");
    expect(makeEndpoint("http://x/v1", "claude-sonnet-4")).toBe("http://x/v1/messages");
    expect(makeEndpoint("http://x/messages", "claude-sonnet-4")).toBe("http://x/messages");
    expect(makeEndpoint("http://x", "gpt-5")).toBe("http://x/v1/responses");
    expect(makeEndpoint("http://x/v1", "gpt-5")).toBe("http://x/v1/responses");
    expect(makeEndpoint("http://x/responses", "gpt-5")).toBe("http://x/responses");
  });

  it("serialises tool calls and tool results for chat-completions", async () => {
    let seen: Record<string, unknown> = {};
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      fetchImpl: (async (_u: string, init: RequestInit) => {
        seen = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      }) as unknown as typeof fetch
    });
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "read", arguments: { path: "a" } }]
      },
      { role: "tool", content: "body", toolCallId: "t1", name: "read" }
    ];
    const tools: ToolDefinition[] = [
      {
        name: "read",
        description: "d",
        parameters: { type: "object" },
        execute: async () => ({ callId: "", name: "read", ok: true, content: "" })
      }
    ];
    await provider.complete(messages, tools);
    expect(seen.tool_choice).toBe("auto");
    const wire = seen.messages as Array<Record<string, unknown>>;
    expect(wire[2]).toMatchObject({
      role: "assistant",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }
      ]
    });
    expect(wire[3]).toMatchObject({ role: "tool", tool_call_id: "t1", content: "body" });
  });

  it("embeds user images as data urls", async () => {
    let seen: Record<string, unknown> = {};
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "gpt-4o",
      fetchImpl: (async (_u: string, init: RequestInit) => {
        seen = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      }) as unknown as typeof fetch
    });
    await provider.complete(
      [
        {
          role: "user",
          content: "look",
          contentBlocks: [
            { type: "text", text: "look" },
            { type: "image", mediaType: "image/png", data: "AAAA" }
          ]
        }
      ],
      noTools
    );
    const wire = seen.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(wire[0]!.content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" }
    });
  });

  it("merges anthropic turns and marks prompt-cache breakpoints", async () => {
    let seen: Record<string, unknown> = {};
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "claude-sonnet-4",
      promptCache: true,
      maxTokens: 123,
      temperature: 0.2,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        seen = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });
      }) as unknown as typeof fetch
    });
    await provider.complete(
      [
        { role: "system", content: "sys one" },
        { role: "system", content: "sys two" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" }
      ],
      noTools
    );
    expect(seen.max_tokens).toBe(123);
    expect(seen.temperature).toBe(0.2);
    expect((seen.system as Array<Record<string, unknown>>).length).toBe(2);
    expect((seen.messages as unknown[]).length).toBe(2);
    expect((seen.system as Array<Record<string, unknown>>)[1]!.cache_control).toBeDefined();
  });

  it("serialises tool calls for the responses protocol", async () => {
    let seen: Record<string, unknown> = {};
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "gpt-5",
      fetchImpl: (async (_u: string, init: RequestInit) => {
        seen = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
        });
      }) as unknown as typeof fetch
    });
    await provider.complete(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", arguments: {} }] },
        { role: "tool", content: "out", toolCallId: "t1", name: "read" }
      ],
      noTools
    );
    const input = seen.input as Array<Record<string, unknown>>;
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "t1", name: "read" });
    expect(input[2]).toMatchObject({ type: "function_call_output", call_id: "t1", output: "out" });
  });
});

describe("provider: response parsing", () => {
  async function completeWith(body: unknown, cfg: Record<string, unknown> = {}): Promise<any> {
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      fetchImpl: (async () => jsonResponse(body)) as unknown as typeof fetch,
      ...cfg
    });
    return provider.complete([{ role: "user", content: "hi" }], noTools);
  }

  it("parses chat-completions text, reasoning and usage details", async () => {
    const r = await completeWith({
      choices: [
        {
          message: {
            content: "hello",
            reasoning_content: "think",
            tool_calls: [{ id: "c", function: { name: "read", arguments: '{"p":1}' } }]
          },
          finish_reason: "tool_calls"
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 }
      }
    });
    expect(r.message.content).toBe("hello");
    expect(r.message.reasoning).toBe("think");
    expect(r.message.toolCalls).toEqual([{ id: "c", name: "read", arguments: { p: 1 } }]);
    expect(r.usage).toMatchObject({ promptTokens: 10, cacheReadTokens: 3, reasoningTokens: 2 });
    expect(r.stopReason).toBe("tool_calls");
  });

  it("defaults usage and stop reason when omitted", async () => {
    const r = await completeWith({ choices: [{ message: {} }] });
    expect(r.message.content).toBe("");
    expect(r.usage.totalTokens).toBe(0);
    expect(r.stopReason).toBe("stop");
  });

  it("maps a length finish reason", async () => {
    const r = await completeWith({
      choices: [{ message: { content: "x" }, finish_reason: "length" }]
    });
    expect(r.stopReason).toBe("length");
  });

  it("parses anthropic thinking and tool_use blocks", async () => {
    const r = await completeWith(
      {
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "tu", name: "read", input: { path: "a" } }
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 2
        }
      },
      { model: "claude-sonnet-4" }
    );
    expect(r.message.content).toBe("answer");
    expect(r.message.reasoning).toBe("hm");
    expect(r.message.toolCalls![0]).toEqual({ id: "tu", name: "read", arguments: { path: "a" } });
    expect(r.usage).toMatchObject({ cacheReadTokens: 1, cacheWriteTokens: 2 });
  });

  it("maps anthropic stop reasons", async () => {
    const long = await completeWith(
      { content: [], stop_reason: "max_tokens" },
      { model: "claude-sonnet-4" }
    );
    expect(long.stopReason).toBe("length");
    const done = await completeWith(
      { content: [{ type: "text", text: "x" }], stop_reason: "end_turn" },
      { model: "claude-sonnet-4" }
    );
    expect(done.stopReason).toBe("stop");
  });

  it("parses responses reasoning summaries and function calls", async () => {
    const r = await completeWith(
      {
        output: [
          { type: "reasoning", summary: [{ text: "why" }] },
          { type: "message", content: [{ type: "output_text", text: "hey" }] },
          { type: "function_call", call_id: "fc", name: "read", arguments: '{"a":1}' }
        ],
        status: "completed",
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 1 },
          output_tokens_details: { reasoning_tokens: 1 }
        }
      },
      { model: "gpt-5" }
    );
    expect(r.message.content).toBe("hey");
    expect(r.message.reasoning).toBe("why");
    expect(r.message.toolCalls![0]).toMatchObject({ id: "fc", arguments: { a: 1 } });
    expect(r.usage).toMatchObject({ cacheReadTokens: 1, reasoningTokens: 1 });
  });

  it("treats an incomplete responses run as length", async () => {
    expect(
      (await completeWith({ output: [], status: "incomplete" }, { model: "gpt-5" })).stopReason
    ).toBe("length");
  });
});

describe("provider: streaming", () => {
  async function drain(
    provider: NativeProvider,
    messages: ChatMessage[] = [{ role: "user", content: "hi" }]
  ): Promise<any[]> {
    const out: any[] = [];
    for await (const ev of provider.stream(messages, noTools)) out.push(ev);
    return out;
  }

  it("streams chat-completions text, tool deltas and usage", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"read","arguments":"{\\"p\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}\n\n',
      'data: {"choices":[{"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":1}}}\n\n',
      "data: [DONE]\n\n"
    ];
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      fetchImpl: (async () => new Response(sse(frames), { status: 200 })) as unknown as typeof fetch
    });
    const events = await drain(provider);
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.delta)
        .join("")
    ).toBe("hello");
    expect(events.find((e) => e.type === "tool_call").call).toEqual({
      id: "t1",
      name: "read",
      arguments: { p: 1 }
    });
    expect(events.find((e) => e.type === "usage").usage).toMatchObject({ promptTokens: 3 });
    expect(events.at(-1)).toEqual({ type: "stop", stopReason: "tool_calls" });
  });

  it("streams anthropic content blocks", async () => {
    const frames = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu","name":"read"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":5,"output_tokens":4}}\n\n',
      "data: [DONE]\n\n"
    ];
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "claude-sonnet-4",
      fetchImpl: (async () => new Response(sse(frames), { status: 200 })) as unknown as typeof fetch
    });
    const events = await drain(provider);
    expect(events.find((e) => e.type === "text").delta).toBe("hi");
    expect(events.find((e) => e.type === "reasoning").delta).toBe("hm");
    expect(events.find((e) => e.type === "tool_call").call).toEqual({
      id: "tu",
      name: "read",
      arguments: { a: 1 }
    });
    expect(events.at(-1)).toEqual({ type: "stop", stopReason: "tool_calls" });
  });

  it("maps anthropic max_tokens and plain stops", async () => {
    const mk = (stop: string) =>
      new NativeProvider({
        baseUrl: "http://x",
        model: "claude-sonnet-4",
        fetchImpl: (async () =>
          new Response(
            sse([
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
              `data: {"type":"message_delta","delta":{"stop_reason":"${stop}"}}\n\n`
            ]),
            { status: 200 }
          )) as unknown as typeof fetch
      });
    expect((await drain(mk("max_tokens"))).at(-1)).toEqual({ type: "stop", stopReason: "length" });
    expect((await drain(mk("end_turn"))).at(-1)).toEqual({ type: "stop", stopReason: "stop" });
  });

  it("streams responses text, reasoning and function calls", async () => {
    const frames = [
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"why"}\n\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"fc","name":"read"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"a\\":1}"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":1}}}}\n\n'
    ];
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "gpt-5",
      fetchImpl: (async () => new Response(sse(frames), { status: 200 })) as unknown as typeof fetch
    });
    const events = await drain(provider);
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.delta)
        .join("")
    ).toBe("hi");
    expect(events.find((e) => e.type === "reasoning").delta).toBe("why");
    expect(events.find((e) => e.type === "tool_call").call).toMatchObject({ id: "fc" });
    expect(events.find((e) => e.type === "usage").usage.cacheReadTokens).toBe(1);
  });

  it("maps an incomplete responses run to a length stop", async () => {
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "gpt-5",
      fetchImpl: (async () =>
        new Response(sse(['data: {"type":"response.incomplete"}\n\n']), {
          status: 200
        })) as unknown as typeof fetch
    });
    expect((await drain(provider)).at(-1)).toEqual({ type: "stop", stopReason: "length" });
  });

  it("skips unparsable SSE data frames", async () => {
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      fetchImpl: (async () =>
        new Response(
          sse(["data: {not json\n\n", 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']),
          { status: 200 }
        )) as unknown as typeof fetch
    });
    const events = await drain(provider);
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.delta)
        .join("")
    ).toBe("ok");
  });

  it("estimates usage when the stream never reports it", async () => {
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      fetchImpl: (async () =>
        new Response(sse(['data: {"choices":[{"delta":{"content":"abcd"}}]}\n\n']), {
          status: 200
        })) as unknown as typeof fetch
    });
    const events = await drain(provider, [{ role: "user", content: "x".repeat(40) }]);
    const usage = events.find((e) => e.type === "usage").usage;
    expect(usage.promptTokens).toBeGreaterThan(0);
    expect(usage.completionTokens).toBeGreaterThan(0);
  });
});

describe("provider: transport errors and retries", () => {
  it("surfaces a non-2xx status", async () => {
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      retries: 1,
      fetchImpl: (async () =>
        new Response("bad key sk-abcdefghijklmnop", { status: 401 })) as unknown as typeof fetch
    });
    await expect(provider.complete([{ role: "user", content: "hi" }], noTools)).rejects.toThrow(
      /401/
    );
  });

  it("retries a transient 500 and succeeds", async () => {
    let calls = 0;
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      retries: 3,
      retryBaseMs: 1,
      fetchImpl: (async () => {
        calls += 1;
        if (calls < 3) return new Response("busy", { status: 500 });
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      }) as unknown as typeof fetch
    });
    expect(
      (await provider.complete([{ role: "user", content: "hi" }], noTools)).message.content
    ).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry a 400", async () => {
    let calls = 0;
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      retries: 5,
      retryBaseMs: 1,
      fetchImpl: (async () => {
        calls += 1;
        return new Response("bad", { status: 400 });
      }) as unknown as typeof fetch
    });
    await expect(provider.complete([{ role: "user", content: "hi" }], noTools)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("reports a request timeout as retryable", async () => {
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      retries: 1,
      requestTimeoutMs: 5,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        // Mimic real fetch: reject as soon as the attempt signal aborts.
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 200);
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true }
          );
        });
        return jsonResponse({});
      }) as unknown as typeof fetch
    });
    await expect(provider.complete([{ role: "user", content: "hi" }], noTools)).rejects.toThrow(
      /timed out/
    );
  });

  it("opens the circuit breaker after repeated failures", async () => {
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      retries: 1,
      fetchImpl: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch
    });
    for (let i = 0; i < 5; i += 1) {
      await provider.complete([{ role: "user", content: "hi" }], noTools).catch(() => undefined);
    }
    await expect(provider.complete([{ role: "user", content: "hi" }], noTools)).rejects.toThrow(
      /circuit breaker/
    );
  });
});

describe("provider: summarize and helpers", () => {
  it("summarises with a stripped body", async () => {
    let seen: Record<string, unknown> = {};
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      fetchImpl: (async (_u: string, init: RequestInit) => {
        seen = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ choices: [{ message: { content: "SUMMARY" } }] });
      }) as unknown as typeof fetch
    });
    expect(await provider.summarize([{ role: "user", content: "long" }])).toBe("SUMMARY");
    expect(seen.tools).toBeUndefined();
  });

  it("falls back when the summary is empty", async () => {
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      fetchImpl: (async () =>
        jsonResponse({ choices: [{ message: {} }] })) as unknown as typeof fetch
    });
    expect(await provider.summarize([{ role: "user", content: "x" }])).toBe(
      "(summary unavailable)"
    );
  });

  it("collectStream merges deltas and prefers tool_calls", async () => {
    const provider = new NativeProvider({
      baseUrl: "http://x",
      model: "deepseek-chat",
      fetchImpl: (async () =>
        new Response(
          sse([
            'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_content":"r"}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t","function":{"name":"read","arguments":"{}"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"b"}}]}\n\n'
          ]),
          { status: 200 }
        )) as unknown as typeof fetch
    });
    const seen: string[] = [];
    const r = await collectStream(provider, [{ role: "user", content: "hi" }], noTools, {
      onEvent: (e) => seen.push(e.type)
    });
    expect(r.message.content).toBe("ab");
    expect(r.message.reasoning).toBe("r");
    expect(r.stopReason).toBe("tool_calls");
    expect(seen).toContain("tool_call");
  });

  it("collectStream uses complete without a stream method", async () => {
    const r = await collectStream(
      new ScriptedProvider(),
      [{ role: "user", content: "hi" }],
      noTools
    );
    expect(r.message.content).toContain("scripted reply");
  });

  it("ScriptedProvider replays turns then falls back", async () => {
    const provider = new ScriptedProvider({
      model: "deepseek-chat",
      turns: [
        {
          message: { role: "assistant", content: "first" },
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          stopReason: "stop"
        }
      ]
    });
    expect((await provider.complete([], noTools)).message.content).toBe("first");
    expect(
      (await provider.complete([{ role: "user", content: "x" }], noTools)).message.content
    ).toContain("last role=user");
  });

  it("ScriptedProvider summarises tools and commands", async () => {
    const provider = new ScriptedProvider();
    const summary = await provider.summarize([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "a", name: "bash", arguments: { command: "ls" } }]
      },
      { role: "tool", content: "out", toolCallId: "a", name: "bash" }
    ]);
    expect(summary).toContain("Tools used: bash");
    expect(summary).toContain("Commands: ls");
  });

  it("makeProvider builds the requested kinds", () => {
    expect(makeProvider({ kind: "scripted" }).model).toBe("scripted");
    expect(makeProvider({ kind: "anthropic", model: "claude-sonnet-4" }).model).toBe(
      "claude-sonnet-4"
    );
    expect((makeProvider({ kind: "responses", model: "gpt-5" }) as NativeProvider).protocol).toBe(
      "openai-responses"
    );
    expect(
      (makeProvider({ kind: "openai", model: "deepseek-chat" }) as NativeProvider).protocol
    ).toBe("chat-completions");
  });

  it("parseToolArguments coerces non-object JSON and flags parse errors", () => {
    expect(parseToolArguments(undefined)).toEqual({});
    expect(parseToolArguments("   ")).toEqual({});
    expect(parseToolArguments("[]")).toEqual({ value: [] });
    expect(parseToolArguments("{bad")).toEqual({ __parseError: "{bad" });
  });

  it("finishToolCalls sorts, fills gaps and defaults missing fields", () => {
    const out = finishToolCalls(
      new Map([
        [3, { id: "c3", name: "n3", args: '{"x":1}' }],
        [0, { id: "", name: "", args: "nope" }]
      ])
    );
    expect(out.map((c) => c.name)).toEqual(["unknown", "n3"]);
    expect(out[1]!.arguments).toEqual({ x: 1 });
    expect(out[0]!.id).toMatch(/^call-/);
  });

  it("thinkingBody switches on provider and budget size", () => {
    expect(thinkingBody("claude-sonnet-4", 2000)).toEqual({
      thinking: { type: "enabled", budget_tokens: 2000 }
    });
    expect(thinkingBody("claude-sonnet-4", false)).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingBody("deepseek-reasoner", 20000)).toEqual({ reasoning: { effort: "high" } });
    expect(thinkingBody("deepseek-reasoner", true)).toEqual({ reasoning: { effort: "medium" } });
    expect(thinkingBody("gpt-4o", undefined)).toEqual({});
  });

  it("providerSleep resolves immediately when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(providerSleep(1000, ac.signal)).resolves.toBeUndefined();
  });

  it("parseSse handles empty streams and comments", async () => {
    const out: any[] = [];
    for await (const f of parseSse(sse([": ping\n\n", ""]))) out.push(f);
    expect(out).toEqual([]);
  });
});

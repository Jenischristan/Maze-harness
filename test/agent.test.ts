import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop, contextUsage } from "../src/agent/loop.js";
import { OpenAICompatProvider, ScriptedProvider } from "../src/agent/provider.js";
import { ToolExecutor, ToolRegistry } from "../src/tools/index.js";
import { Hooks } from "../src/tools/hooks.js";
import { DEFAULT_PERMISSION_POLICY } from "../src/tools/permissions.js";
import { SessionStore } from "../src/session/store.js";
import { CostTracker } from "../src/cost.js";
import type { ChatResult, ToolCall } from "../src/types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-agent-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function toolCall(name: string, args: Record<string, unknown>, id = "c1"): ChatResult {
  const call: ToolCall = { id, name, arguments: args };
  return {
    message: { role: "assistant", content: "", toolCalls: [call] },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    stopReason: "tool_calls"
  };
}

function reply(content: string): ChatResult {
  return {
    message: { role: "assistant", content },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    stopReason: "stop"
  };
}

async function makeLoop(turns: ChatResult[]) {
  const session = new SessionStore({ dir, runId: "loop" });
  await session.init();
  const registry = new ToolRegistry();
  const executor = new ToolExecutor({
    registry,
    workspaceDir: dir,
    permission: { ...DEFAULT_PERMISSION_POLICY, defaultAction: "allow" },
    hooks: new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 })
  });
  const events: string[] = [];
  const result = await runAgentLoop(
    {
      provider: new ScriptedProvider({ turns }),
      tools: registry.list(),
      executor,
      session,
      systemPrompt: "system",
      maxTurns: 10,
      compaction: { contextWindow: 100_000, reserveTokens: 1000, keepRecentTokens: 1000 },
      cost: new CostTracker({ model: "scripted" }),
      onEvent: (e) => events.push(e.type)
    },
    "do the thing"
  );
  return { result, session, events };
}

describe("agent loop", () => {
  it("executes a tool call then finishes", async () => {
    const { result, session, events } = await makeLoop([
      toolCall("write", { path: "out.txt", content: "hello" }),
      reply("done")
    ]);
    expect(result.stopReason).toBe("done");
    expect(result.turns).toBe(2);
    expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("hello");
    expect(events).toContain("tool-result");
    const projection = session.projection();
    expect(projection.at(-1)!.content).toBe("done");
  });

  it("stops at max turns", async () => {
    const turns: ChatResult[] = [];
    for (let i = 0; i < 20; i += 1) {
      turns.push(toolCall("read", { path: `f${i}.txt` }, `c${i}`));
    }
    const { result } = await makeLoop(turns);
    expect(result.stopReason).toBe("max-turns");
    expect(result.turns).toBe(10);
  });

  it("detects identical repeated tool batches", async () => {
    const call = toolCall("read", { path: "same.txt" });
    const turns: ChatResult[] = [];
    for (let i = 0; i < 10; i += 1) turns.push(call);
    const { result } = await makeLoop(turns);
    expect(result.stopReason).toBe("loop");
    expect(result.error).toMatch(/loop detected/);
  });

  it("recovers when a tool returns an error", async () => {
    const { result } = await makeLoop([
      toolCall("read", { path: "missing.txt" }),
      reply("recovered")
    ]);
    expect(result.stopReason).toBe("done");
    expect(result.messages.at(-1)!.content).toBe("recovered");
  });

  it("reports context usage", () => {
    const usage = contextUsage([{ role: "user", content: "x".repeat(400) }], 1000);
    expect(usage.tokens).toBeGreaterThan(0);
    expect(usage.pct).toBeGreaterThan(0);
  });
});

describe("OpenAI-compatible provider", () => {
  it("parses tool calls and usage from a response", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "thinking",
                tool_calls: [
                  {
                    id: "abc",
                    type: "function",
                    function: { name: "read", arguments: '{"path":"a.txt"}' }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as typeof fetch;
    const provider = new OpenAICompatProvider({
      baseUrl: "http://test/v1/chat/completions",
      model: "test-model",
      fetchImpl
    });
    const res = await provider.complete([{ role: "user", content: "hi" }], []);
    expect(res.stopReason).toBe("tool_calls");
    expect(res.message.content).toBe("thinking");
    expect(res.message.toolCalls).toHaveLength(1);
    expect(res.message.toolCalls![0]).toMatchObject({
      id: "abc",
      name: "read",
      arguments: { path: "a.txt" }
    });
    expect(res.usage.totalTokens).toBe(10);
  });

  it("surfaces non-retryable provider errors", async () => {
    const fetchImpl = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    const provider = new OpenAICompatProvider({
      baseUrl: "http://test",
      model: "m",
      fetchImpl
    });
    await expect(provider.complete([{ role: "user", content: "hi" }], [])).rejects.toThrow(
      /provider 400/
    );
  });

  it("retries retryable failures then succeeds", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) return new Response("busy", { status: 429 });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    const provider = new OpenAICompatProvider({
      baseUrl: "http://test",
      model: "m",
      fetchImpl,
      retries: 3,
      retryBaseMs: 1
    });
    const res = await provider.complete([{ role: "user", content: "hi" }], []);
    expect(res.message.content).toBe("ok");
    expect(n).toBe(2);
  });

  it("summarizes via the provider", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "the summary" }, finish_reason: "stop" }],
          usage: {}
        }),
        { status: 200 }
      )) as typeof fetch;
    const provider = new OpenAICompatProvider({
      baseUrl: "http://test",
      model: "m",
      fetchImpl
    });
    const summary = await provider.summarize([{ role: "user", content: "history" }]);
    expect(summary).toBe("the summary");
  });
});

describe("runChatOnce integration", () => {
  it("creates a persisted session and surfaces provider failure", async () => {
    const { buildSession } = await import("../src/chat.js");
    const { buildSystemPrompt } = await import("../src/agent/prompts.js");
    const built = await buildSession({
      model: "m",
      baseUrl: "http://127.0.0.1:1/v1/chat/completions",
      apiKey: "",
      contextWindow: 8000,
      runsDir: join(dir, "runs"),
      verifyCommands: [],
      permission: "allow"
    });
    expect(existsSync(built.session.path)).toBe(true);
    const prompt = await buildSystemPrompt({ memory: "# memory\nuse pnpm" });
    expect(prompt).toContain("use pnpm");
    expect(prompt).toContain("# Identity");
    const withGoal = await buildSystemPrompt({
      memory: "",
      goal: {
        id: "g1",
        title: "make tests pass",
        detail: "",
        status: "active",
        createdAt: "",
        updatedAt: ""
      }
    });
    expect(withGoal).toContain("make tests pass");
    expect(withGoal).toContain("GOAL COMPLETE");
    await expect(
      built.provider.complete([{ role: "user", content: "hi" }], [], AbortSignal.timeout(500))
    ).rejects.toThrow();
  }, 20000);
});

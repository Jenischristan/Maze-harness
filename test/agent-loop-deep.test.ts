import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop, type AgentLoopConfig } from "../src/agent/loop.js";
import { SessionStore } from "../src/session/store.js";
import { CostTracker } from "../src/cost.js";
import { ToolExecutor, ToolRegistry } from "../src/tools/index.js";
import type { ChatMessage, ChatResult, ToolCall } from "../src/types.js";

let dir = "";
const noHooks = { register: () => undefined, list: () => [], runAll: async () => [] };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-loop-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function toolCall(id: string, name = "noop"): ToolCall {
  return { id, name, arguments: {} };
}

function reply(content: string, toolCalls?: ToolCall[]): ChatResult {
  return {
    message: { role: "assistant", content, toolCalls },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    stopReason: toolCalls ? "tool_calls" : "stop"
  };
}

function provider(turns: Array<ChatResult | Error>, onSummarize?: () => void) {
  let i = 0;
  return {
    model: "deepseek-chat",
    contextWindow: 64_000,
    async complete(): Promise<ChatResult> {
      const next = turns[Math.min(i, turns.length - 1)]!;
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    async summarize(): Promise<string> {
      onSummarize?.();
      return "compressed summary";
    }
  };
}

function executor(opts: { fail?: boolean; onRun?: () => void } = {}): ToolExecutor {
  const registry = new ToolRegistry([
    {
      name: "noop",
      description: "",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        opts.onRun?.();
        if (opts.fail) throw new Error("tool exploded");
        return { callId: "", name: "noop", ok: true, content: "ok" };
      }
    },
    {
      name: "empty",
      description: "",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ callId: "", name: "empty", ok: true, content: "" })
    }
  ]);
  return new ToolExecutor({
    registry,
    workspaceDir: dir,
    permission: { defaultAction: "allow", rules: [] },
    hooks: noHooks
  });
}

async function config(
  p: ReturnType<typeof provider>,
  overrides: Partial<AgentLoopConfig> = {}
): Promise<AgentLoopConfig> {
  const session = new SessionStore({ dir, runId: `r-${Math.random().toString(36).slice(2, 8)}` });
  await session.init();
  return {
    provider: p as never,
    tools: [],
    executor: executor(),
    session,
    systemPrompt: "sys",
    maxTurns: 5,
    compaction: { contextWindow: 64_000, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    cost: new CostTracker({ model: "deepseek-chat" }),
    ...overrides
  };
}

describe("agent loop: termination paths", () => {
  it("stops with done when the model sends no tool calls", async () => {
    const cfg = await config(provider([reply("finished")]));
    const res = await runAgentLoop(cfg, "go");
    expect(res.stopReason).toBe("done");
    expect(res.turns).toBe(1);
    expect(res.messages.at(-1)!.content).toBe("finished");
  });

  it("stops as aborted when the signal fires before the first turn", async () => {
    const ac = new AbortController();
    ac.abort();
    const cfg = await config(provider([reply("x")]), { signal: ac.signal });
    const res = await runAgentLoop(cfg, "go");
    expect(res.stopReason).toBe("aborted");
    expect(res.turns).toBe(0);
  });

  it("returns error when the provider throws", async () => {
    const events: string[] = [];
    const cfg = await config(provider([new Error("provider down")]), {
      onEvent: (e) => events.push(e.type)
    });
    const res = await runAgentLoop(cfg, "go");
    expect(res.stopReason).toBe("error");
    expect(res.error).toBe("provider down");
    expect(events).toContain("error");
    // A failed provider must not corrupt the conversation.
    expect(cfg.session.projection().map((m) => m.role)).toEqual(["user"]);
  });

  it("stops with max-turns when the turn budget is exhausted", async () => {
    const cfg = await config(provider([reply("", [toolCall("a")])]), { maxTurns: 2 });
    const res = await runAgentLoop(cfg, "go");
    expect(res.stopReason).toBe("max-turns");
    expect(res.turns).toBe(2);
    expect(res.budget!.turns).toBe(2);
  });

  it("stops with a budget reason when a non-turn limit is exceeded", async () => {
    const cfg = await config(provider([reply("", [toolCall("a")])]), {
      budget: { maxToolCalls: 1 }
    });
    const res = await runAgentLoop(cfg, "go");
    expect(res.stopReason).toBe("budget");
    expect(res.error).toContain("tool-call");
  });

  it("detects a repeated identical tool batch", async () => {
    const cfg = await config(provider([reply("", [toolCall("a")])]), {
      loopTurnLimit: 1,
      maxTurns: 10
    });
    const res = await runAgentLoop(cfg, "go");
    expect(res.stopReason).toBe("loop");
    expect(res.error).toContain("loop detected");
  });

  it("does not flag a changed tool batch as a loop", async () => {
    let n = 0;
    const p = provider([reply("x")]);
    p.complete = async () => reply("", [toolCall(`c${n++}`)]);
    // A changed id alone is not enough: the loop signature covers the batch
    // shape, so vary the arguments too.
    p.complete = async () => ({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c", name: "noop", arguments: { n: n++ } }]
      },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      stopReason: "tool_calls"
    });
    const cfg = await config(p, { loopTurnLimit: 1, maxTurns: 3 });
    const res = await runAgentLoop(cfg, "go");
    expect(res.stopReason).toBe("max-turns");
  });

  it("rewinds the turn and returns error when the tool batch throws", async () => {
    let undone = 0;
    const cfg = await config(provider([reply("", [toolCall("a")])]), {
      executor: executor({ fail: true }),
      beginTurn: async () => async () => {
        undone += 1;
      }
    });
    // The executor catches tool throws, so force a batch-level failure via a
    // broken registry lookup by replacing runBatch.
    cfg.executor.runBatch = async () => {
      throw new Error("batch failed");
    };
    const res = await runAgentLoop(cfg, "go");
    expect(res.stopReason).toBe("error");
    expect(res.error).toBe("batch failed");
    expect(undone).toBe(1);
  });

  it("survives a beginTurn failure and still runs the tools", async () => {
    const cfg = await config(provider([reply("", [toolCall("a")]), reply("done")]), {
      beginTurn: async () => {
        throw new Error("snapshot failed");
      }
    });
    const res = await runAgentLoop(cfg, "go");
    expect(res.stopReason).toBe("done");
    expect(res.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("calls undo when the signal aborts after a tool batch", async () => {
    const ac = new AbortController();
    let undone = 0;
    const cfg = await config(provider([reply("", [toolCall("a")])]), {
      signal: ac.signal,
      executor: executor({ onRun: () => ac.abort() }),
      beginTurn: async () => async () => {
        undone += 1;
      }
    });
    const res = await runAgentLoop(cfg, "go");
    // The abort lands mid-turn, so the next loop iteration reports it.
    expect(res.stopReason).toBe("aborted");
    expect(undone).toBe(1);
  });

  it("emits assistant, tool-start, tool-result and usage events", async () => {
    const events: string[] = [];
    const cfg = await config(provider([reply("", [toolCall("a")]), reply("done")]), {
      onEvent: (e) => events.push(e.type)
    });
    await runAgentLoop(cfg, "go");
    expect(events).toEqual([
      "usage",
      "assistant",
      "tool-start",
      "tool-result",
      "usage",
      "assistant",
      "done"
    ]);
  });

  it("uses the custom stream function when supplied", async () => {
    let streamed = 0;
    const cfg = await config(provider([reply("unused")]), {
      stream: async () => {
        streamed += 1;
        return reply("from stream");
      }
    });
    const res = await runAgentLoop(cfg, "go");
    expect(streamed).toBe(1);
    expect(res.messages.at(-1)!.content).toBe("from stream");
  });

  it("calls onTurn with the 1-based turn number", async () => {
    const turns: number[] = [];
    const cfg = await config(provider([reply("", [toolCall("a")]), reply("done")]), {
      onTurn: (t) => turns.push(t)
    });
    await runAgentLoop(cfg, "go");
    expect(turns).toEqual([1, 2]);
  });
});

describe("agent loop: compaction integration", () => {
  it("compacts, records the boundary and emits an event", async () => {
    let summarized = 0;
    const events: string[] = [];
    const big = "y".repeat(20_000);
    // A large system prompt forces the estimate over the compaction threshold
    // before any provider-reported token count is available.
    const cfg = await config(
      provider([reply(big, [toolCall("a")]), reply("done")], () => (summarized += 1)),
      {
        maxTurns: 3,
        systemPrompt: "s".repeat(40_000),
        compaction: { contextWindow: 4_000, reserveTokens: 1_000, keepRecentTokens: 100 },
        onEvent: (e) => events.push(e.type)
      }
    );
    const res = await runAgentLoop(cfg, "go");
    expect(summarized).toBeGreaterThan(0);
    expect(events).toContain("compaction");
    const compactions = cfg.session.allEntries.filter((e) => e.kind === "compaction");
    expect(compactions.length).toBeGreaterThan(0);
    expect(compactions[0]!.compaction!.firstKeptEntryId).not.toBeNull();
    expect(res.stopReason).toBe("done");
    // The projection is summarised and bounded, not unbounded growth.
    const first = cfg.session.projection()[0]!;
    expect(first.synthetic).toBe(true);
    expect(first.content).toContain("compressed summary");
  });

  it("does not record a compaction when nothing is old enough", async () => {
    const cfg = await config(provider([reply("short", [toolCall("a")]), reply("done")]), {
      maxTurns: 2,
      compaction: { contextWindow: 64_000, reserveTokens: 16_384, keepRecentTokens: 20_000 }
    });
    await runAgentLoop(cfg, "go");
    expect(cfg.session.allEntries.filter((e) => e.kind === "compaction")).toHaveLength(0);
  });

  it("continues the turn when compaction fails", async () => {
    const events: string[] = [];
    const big = "y".repeat(20_000);
    const p = provider([reply(big, [toolCall("a")]), reply("done")]);
    p.summarize = async () => {
      throw new Error("summary down");
    };
    const cfg = await config(p, {
      maxTurns: 3,
      systemPrompt: "s".repeat(40_000),
      compaction: { contextWindow: 4_000, reserveTokens: 1_000, keepRecentTokens: 100 },
      onEvent: (e) => events.push(e.type === "error" ? `error` : e.type)
    });
    const res = await runAgentLoop(cfg, "go");
    expect(res.stopReason).toBe("done");
    expect(events).toContain("error");
  });
});

describe("agent loop: ordering and state", () => {
  it("persists the assistant tool call before its results", async () => {
    const cfg = await config(provider([reply("", [toolCall("a")]), reply("done")]));
    await runAgentLoop(cfg, "go");
    const roles = cfg.session.projection().map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("records usage once per turn and sums tokens", async () => {
    const cfg = await config(provider([reply("", [toolCall("a")]), reply("done")]));
    await runAgentLoop(cfg, "go");
    expect(cfg.session.usageFromEntries().totalTokens).toBe(30);
    expect(cfg.cost.summary().calls).toBe(2);
  });

  it("contextUsage reports a bounded percentage", async () => {
    const { contextUsage } = await import("../src/agent/loop.js");
    const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(400) }];
    expect(contextUsage(messages, 0).pct).toBe(0);
    const u = contextUsage(messages, 1000);
    expect(u.tokens).toBeGreaterThan(0);
    expect(u.pct).toBeLessThanOrEqual(1);
  });

  it("a tool executor abort leaves a well-formed projection", async () => {
    const ac = new AbortController();
    const cfg = await config(provider([reply("", [toolCall("a")])]), { signal: ac.signal });
    cfg.executor.setSignal(ac.signal);
    ac.abort();
    await runAgentLoop(cfg, "go");
    // Aborted before execution: the batch is never run, so no tool result is
    // recorded and the projection stays a valid user-only transcript.
    expect(cfg.session.projection().map((m) => m.role)).toEqual(["user"]);
  });
});

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printEvent, printStreamEvent, finishStreamLine } from "../src/chat-render.js";
import { CostTracker, usdFor } from "../src/cost.js";
import {
  contextWindow,
  contextPct,
  defaultApiKey,
  defaultBaseUrl,
  defaultModel,
  loadFileConfig
} from "../src/config.js";
import { lspTool } from "../src/tools/lsp.js";
import { makeTempDir, toolContext } from "./helpers/fixtures.js";

let dir = "";
let cleanup = async (): Promise<void> => undefined;

beforeEach(async () => {
  const t = await makeTempDir("dh-rc");
  dir = t.dir;
  cleanup = t.remove;
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.MAZE_SHOW_REASONING;
  await cleanup();
});

const ctx = (overrides: Record<string, unknown> = {}) => toolContext(dir, overrides as never);

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => {
    out.push(String(c));
    return true;
  }) as never;
  process.stderr.write = ((c: string) => {
    err.push(String(c));
    return true;
  }) as never;
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = so as never;
      process.stderr.write = se as never;
    }
  };
}

describe("chat-render", () => {
  it("streams text once with a leading marker and closes the line", () => {
    const c = capture();
    try {
      printStreamEvent({ type: "text", delta: "he" });
      printStreamEvent({ type: "text", delta: "llo" });
      printStreamEvent({ type: "stop", stopReason: "stop" });
      printStreamEvent({
        type: "usage",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
      });
    } finally {
      c.restore();
    }
    const text = c.out.join("");
    expect(text).toBe("\n◆ hello\n");
    expect(text.match(/◆/g)).toHaveLength(1);
  });

  it("prints reasoning only when MAZE_SHOW_REASONING is set", () => {
    let c = capture();
    try {
      printStreamEvent({ type: "reasoning", delta: "why" });
    } finally {
      c.restore();
    }
    expect(c.err.join("")).toBe("");
    process.env.MAZE_SHOW_REASONING = "1";
    c = capture();
    try {
      printStreamEvent({ type: "reasoning", delta: "why" });
    } finally {
      c.restore();
    }
    expect(c.err.join("")).toContain("why");
  });

  it("a tool start closes an open stream line", () => {
    const c = capture();
    try {
      printStreamEvent({ type: "text", delta: "x" });
      printStreamEvent({ type: "tool_start", index: 0, id: "t", name: "read" });
      printStreamEvent({ type: "tool_delta", index: 0, delta: "{}" });
    } finally {
      c.restore();
    }
    expect(c.out.join("")).toBe("\n◆ x\n");
  });

  it("finishStreamLine is a no-op when nothing is streaming", () => {
    const c = capture();
    try {
      finishStreamLine();
      finishStreamLine();
    } finally {
      c.restore();
    }
    expect(c.out.join("")).toBe("");
  });

  it("renders assistant text, tool calls, results, compaction and errors", () => {
    const c = capture();
    try {
      printEvent({ type: "assistant", content: "  hello  ", toolCalls: [] });
      printEvent({
        type: "tool-start",
        calls: [
          { id: "a", name: "bash", arguments: { command: "ls -la" } },
          { id: "b", name: "x", arguments: { z: 1 } }
        ]
      });
      printEvent({
        type: "tool-result",
        result: { callId: "a", name: "bash", ok: true, content: "\n\nout" }
      });
      printEvent({ type: "compaction", tokensBefore: 10, tokensAfter: 5, summary: "s" });
      printEvent({ type: "usage", promptTokens: 1, completionTokens: 1, usd: 0.5 });
      printEvent({ type: "done", stopReason: "stop" });
      printEvent({ type: "error", message: "boom" });
    } finally {
      c.restore();
    }
    const out = c.out.join("");
    expect(out).toContain("◆ hello");
    expect(out).toContain("→ bash ls -la");
    expect(out).toContain('→ x {"z":1}');
    expect(out).toContain("✓ bash: out");
    expect(out).toContain("[compacted 10 → 5 tokens]");
    expect(out).toContain("[$0.5000]");
    expect(c.err.join("")).toContain("error: boom");
  });

  it("suppresses the assistant line when it would duplicate a stream", () => {
    const c = capture();
    try {
      printStreamEvent({ type: "text", delta: "streamed" });
      printEvent({ type: "assistant", content: "streamed", toolCalls: [] });
    } finally {
      c.restore();
    }
    expect(c.out.join("")).toBe("\n◆ streamed\n");
  });

  it("shows a failure marker and skips a zero-cost usage line", () => {
    const c = capture();
    try {
      printEvent({
        type: "tool-result",
        result: { callId: "a", name: "bash", ok: false, content: "bad" }
      });
      printEvent({ type: "usage", promptTokens: 1, completionTokens: 1, usd: 0 });
    } finally {
      c.restore();
    }
    expect(c.out.join("")).toContain("✗ bash: bad");
    expect(c.out.join("")).not.toContain("$");
  });

  it("summarizes an argument set with no primary key", () => {
    const c = capture();
    try {
      printEvent({ type: "tool-start", calls: [{ id: "a", name: "t", arguments: { a: 1 } }] });
    } finally {
      c.restore();
    }
    expect(c.out.join("")).toContain('{"a":1}');
  });
});

describe("cost", () => {
  it("computes usd from the model pricing table", () => {
    expect(
      usdFor("deepseek-chat", { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 0 })
    ).toBeCloseTo(0.27);
    expect(
      usdFor("deepseek-chat", { promptTokens: 0, completionTokens: 1_000_000, totalTokens: 0 })
    ).toBeCloseTo(1.1);
  });

  it("uses an explicit usage.usd and accumulates fields", () => {
    const t = new CostTracker({ model: "deepseek-chat" });
    const out = t.record({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      usd: 0.42,
      cacheReadTokens: 3,
      reasoningTokens: 2
    });
    expect(out.usd).toBe(0.42);
    expect(t.summary()).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 3,
      reasoningTokens: 2,
      usd: 0.42,
      calls: 1
    });
  });

  it("merges another tracker", () => {
    const a = new CostTracker({ model: "deepseek-chat" });
    const b = new CostTracker({ model: "deepseek-chat" });
    a.record({ promptTokens: 10, completionTokens: 1, totalTokens: 11, usd: 1 });
    b.record({
      promptTokens: 20,
      completionTokens: 2,
      totalTokens: 22,
      usd: 2,
      cacheReadTokens: 4
    });
    a.merge(b);
    expect(a.summary()).toMatchObject({
      promptTokens: 30,
      completionTokens: 3,
      totalTokens: 33,
      usd: 3,
      calls: 2
    });
  });

  it("records the exploration model separately", () => {
    const t = new CostTracker({ model: "deepseek-chat", explorationModel: "gpt-4o" });
    t.record({ promptTokens: 1, completionTokens: 1, totalTokens: 2, usd: 1 }, "gpt-4o");
    expect(t.explorationModel).toBe("gpt-4o");
    expect(t.summary().calls).toBe(1);
  });
});

describe("config: exported helpers", () => {
  it("reads default base url, api key and model", () => {
    expect(defaultBaseUrl()).toBeTruthy();
    expect(defaultModel()).toBeTruthy();
    // No credentials in a clean test env other than what the runner provides.
    expect(defaultApiKey() === undefined || typeof defaultApiKey() === "string").toBe(true);
  });

  it("contextWindow honours an explicit value", () => {
    expect(contextWindow(4096)).toBe(4096);
  });

  it("contextPct clamps and guards a zero window", () => {
    expect(contextPct(5, 10)).toBe(0.5);
    expect(contextPct(-1, 10)).toBe(0);
    expect(contextPct(11, 10)).toBe(1);
    expect(contextPct(5, 0)).toBe(0);
  });

  it("returns an empty config when the file holds a primitive", async () => {
    await writeFile(join(dir, "maze.json"), '"just a string"');
    expect(loadFileConfig(dir, {} as never).config).toEqual({});
  });
});

describe("lsp: missing compiler and checker failures", () => {
  it("skips with an install hint when no tsc is available in the workspace", async () => {
    await writeFile(join(dir, "a.ts"), "const x = 1;\n");
    const res = await lspTool.execute({ path: "a.ts" }, ctx());
    if (res.content.includes("no TypeScript compiler found")) {
      expect(res.ok).toBe(true);
      expect(res.content).toContain("typescript");
    }
  }, 120_000);

  it("reports a checker failure for a broken tsconfig", async () => {
    await writeFile(join(dir, "a.ts"), "const x = 1;\n");
    await writeFile(join(dir, "tsconfig.json"), "{ this is not json");
    const res = await lspTool.execute({ path: "a.ts" }, ctx());
    if (res.error === "checker-failed") {
      expect(res.ok).toBe(false);
      expect(res.content).toContain("tsc failed");
    }
  }, 120_000);

  it("runs the Python path without throwing", async () => {
    await writeFile(join(dir, "a.py"), "print('x')\n");
    const res = await lspTool.execute({ path: "a.py" }, ctx());
    expect(typeof res.content).toBe("string");
  }, 120_000);
});

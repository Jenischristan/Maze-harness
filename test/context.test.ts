import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compact,
  estimateTokens,
  projectTokens,
  shouldCompact
} from "../src/context/compaction.js";
import { ScriptedProvider } from "../src/agent/provider.js";
import { SessionStore, listSessions } from "../src/session/store.js";
import { loadMemory, MEMORY_FILES } from "../src/context/memory.js";
import { CostTracker, usdFor } from "../src/cost.js";
import type { ChatMessage } from "../src/types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-ctx-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function conversation(n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: "user", content: `user message ${i} ${"x".repeat(200)}` });
    out.push({ role: "assistant", content: `assistant reply ${i} ${"y".repeat(200)}` });
  }
  return out;
}

describe("compaction", () => {
  it("estimates tokens and triggers above the threshold", () => {
    const msgs = conversation(100);
    expect(estimateTokens("abcd")).toBe(1);
    expect(projectTokens(msgs)).toBeGreaterThan(0);
    expect(
      shouldCompact(msgs, { contextWindow: 1000, reserveTokens: 100, keepRecentTokens: 200 })
    ).toBe(true);
    expect(
      shouldCompact([], { contextWindow: 1000, reserveTokens: 100, keepRecentTokens: 200 })
    ).toBe(false);
  });

  it("summarizes old messages and keeps a recent tail", async () => {
    const msgs = conversation(50);
    const provider = new ScriptedProvider();
    const result = await compact(msgs, provider, {
      contextWindow: 8000,
      reserveTokens: 1000,
      keepRecentTokens: 1000
    });
    expect(result.compactedCount).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.messages[0]!.synthetic).toBe(true);
    expect(result.messages[0]!.content).toContain("Summary");

    const kept = result.messages.filter((m) => !m.synthetic);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.at(-1)!.content).toContain("assistant reply 49");
  });

  it("is a no-op when there is nothing old to summarize", async () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
    const result = await compact(msgs, new ScriptedProvider(), {
      contextWindow: 8000,
      reserveTokens: 1000,
      keepRecentTokens: 1000
    });
    expect(result.compactedCount).toBe(0);
    expect(result.messages).toHaveLength(1);
  });
});

describe("session store", () => {
  it("persists messages and rebuilds the active branch", async () => {
    const store = new SessionStore({ dir, runId: "s1", model: "test" });
    await store.init();
    await store.appendMessage({ role: "user", content: "hello" });
    await store.appendMessage({ role: "assistant", content: "hi there" });
    const projection = store.projection();
    expect(projection.map((m) => m.content)).toEqual(["hello", "hi there"]);

    const reopened = new SessionStore({ dir, runId: "s1" });
    await reopened.init();
    expect(reopened.projection().map((m) => m.content)).toEqual(["hello", "hi there"]);
  });

  it("records tool results on the branch", async () => {
    const store = new SessionStore({ dir, runId: "s2" });
    await store.init();
    await store.appendMessage({ role: "assistant", content: "" });
    await store.appendToolResult({
      callId: "c1",
      name: "read",
      ok: true,
      content: "file body"
    });
    const projection = store.projection();
    expect(projection.at(-1)).toMatchObject({ role: "tool", content: "file body", name: "read" });
  });

  it("uses the last compaction summary in the projection", async () => {
    const store = new SessionStore({ dir, runId: "s3" });
    await store.init();
    await store.appendMessage({ role: "user", content: "old one" });
    await store.appendMessage({ role: "user", content: "old two" });
    await store.appendCompaction("summary of old messages", null);
    await store.appendMessage({ role: "user", content: "new" });
    const projection = store.projection();
    expect(projection[0]!.content).toContain("summary of old messages");
    expect(projection.some((m) => m.content === "new")).toBe(true);
  });

  it("tracks usage notes and lists sessions", async () => {
    const store = new SessionStore({ dir, runId: "s4", name: "demo" });
    await store.init();
    await store.recordUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15, usd: 0.01 });
    const usage = store.usageFromEntries();
    expect(usage.totalTokens).toBe(15);
    expect(usage.usd).toBeCloseTo(0.01);

    const sessions = await listSessions(dir);
    const found = sessions.find((s) => s.runId === "s4");
    expect(found).toBeDefined();
    expect(found!.name).toBe("demo");
    expect(found!.tokens).toBe(15);
  });

  it("counts messages and usage for sessions larger than the tail window", async () => {
    // Regression: listSessions only scanned the last 256 KB, so a long session
    // dropped its early usage note and under-reported the message count.
    const store = new SessionStore({ dir, runId: "s5" });
    await store.init();
    await store.recordUsage({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      usd: 0.01
    });
    for (let i = 0; i < 400; i += 1) {
      await store.appendMessage({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(1000)
      });
    }
    const found = (await listSessions(dir)).find((s) => s.runId === "s5");
    expect(found!.messageCount).toBe(400);
    expect(found!.tokens).toBe(150);
    expect(found!.usd).toBeCloseTo(0.01);
  });
});

describe("project memory", () => {
  it("loads known memory files and ignores missing ones", async () => {
    await writeFile(join(dir, "AGENTS.md"), "# Rules\nuse pnpm\n");
    const bundle = await loadMemory(dir);
    expect(bundle.files).toHaveLength(1);
    expect(bundle.text).toContain("use pnpm");
    expect(MEMORY_FILES).toContain("AGENTS.md");
  });

  it("returns an empty bundle when nothing exists", async () => {
    const bundle = await loadMemory(dir);
    expect(bundle.text).toBe("");
  });
});

describe("cost tracking", () => {
  it("prices known models and accumulates", () => {
    const usd = usdFor("deepseek-chat", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000
    });
    expect(usd).toBeCloseTo(0.27 + 1.1, 6);

    const tracker = new CostTracker({ model: "deepseek-chat" });
    tracker.record({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    tracker.record({ promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
    const s = tracker.summary();
    expect(s.promptTokens).toBe(2000);
    expect(s.calls).toBe(2);
    expect(s.usd).toBeGreaterThan(0);
  });
});

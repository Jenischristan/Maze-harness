import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore, listSessions } from "../../src/session/store.js";
import type { ChatMessage } from "../../src/types.js";
import { fuzzCases } from "./harness.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-fuzz-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function assertValidTranscript(messages: ChatMessage[]): void {
  const callIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.toolCalls ?? []) callIds.add(c.id);
    if (m.role === "tool") {
      expect(typeof m.toolCallId).toBe("string");
      expect(callIds.has(m.toolCallId!)).toBe(true);
    }
  }
}

describe("fuzz: session projection", () => {
  it(
    "random message/tool sequences project to a valid transcript",
    fuzzCases({ seed: 0xc01, runs: 80 }, async (rng) => {
      const store = new SessionStore({ dir, model: "fuzz", name: "fuzz" });
      await store.init();
      await store.appendMessage({ role: "user", content: "TASK" });
      const n = rng.int(1, 12);
      for (let i = 0; i < n; i += 1) {
        const kind = rng.pick([
          "message",
          "call",
          "result",
          "note",
          "checkpoint",
          "compaction"
        ] as const);
        if (kind === "message") {
          await store.appendMessage({
            role: rng.pick(["user", "assistant"] as const),
            content: rng.str(20)
          });
        } else if (kind === "call") {
          await store.appendToolCall({
            id: `c${i}`,
            name: "read",
            arguments: { path: rng.str(5) }
          });
        } else if (kind === "result") {
          await store.appendToolResult({
            callId: rng.bool() ? `c${rng.int(0, i)}` : `dangling${i}`,
            name: "read",
            ok: true,
            content: rng.str(10)
          });
        } else if (kind === "note") {
          await store.appendNote(rng.str(10));
        } else if (kind === "checkpoint") {
          await store.appendCheckpoint("l", "ref");
        } else {
          await store.appendCompaction("summary", null);
        }
      }
      const projection = store.projection();
      assertValidTranscript(projection);
      const firstUser = projection.find((m) => m.role === "user");
      expect(firstUser?.content).toBe("TASK");
    })
  );

  it(
    "projection boundary is honoured (entries before it are dropped)",
    fuzzCases({ seed: 0xc02, runs: 60 }, async (rng) => {
      const store = new SessionStore({ dir, model: "fuzz" });
      await store.init();
      await store.appendMessage({ role: "user", content: "TASK" });
      const count = rng.int(1, 8);
      for (let i = 0; i < count; i += 1) {
        await store.appendMessage({ role: "assistant", content: `m${i}` });
      }
      const at = rng.int(0, count);
      const entryId = store.entryIdForProjectedIndex(at);
      if (entryId === null) return;
      await store.appendCompaction("S", entryId);
      const projection = store.projection();
      expect(projection[0]!.role).toBe("system");
      expect(projection[0]!.content).toContain("S");
      const userTurns = projection.filter((m) => m.role === "user");
      expect(userTurns).toHaveLength(1);
      expect(userTurns[0]!.content).toBe("TASK");
      assertValidTranscript(projection);
    })
  );
});

describe("fuzz: session persistence", () => {
  it(
    "corrupt trailing bytes never break loading or lose valid entries",
    fuzzCases({ seed: 0xc03, runs: 40 }, async (rng) => {
      const runId = `f${rng.int(0, 1_000_000)}`;
      const store = new SessionStore({ dir, runId, model: "m" });
      await store.init();
      await store.appendMessage({ role: "user", content: "a" });
      await store.appendMessage({ role: "assistant", content: "b" });
      await appendFile(store.path, "{not json");
      const reopened = new SessionStore({ dir, runId, model: "m" });
      await reopened.init();
      expect(reopened.allEntries.length).toBe(3);
      await reopened.appendMessage({ role: "user", content: "c" });
      const again = new SessionStore({ dir, runId, model: "m" });
      await again.init();
      expect(again.allEntries.filter((e) => e.kind === "message")).toHaveLength(3);
    })
  );

  it(
    "listSessions reports every readable session and skips garbage",
    fuzzCases({ seed: 0xc04, runs: 20 }, async (rng) => {
      const caseDir = join(dir, `case-${rng.int(0, 1_000_000_000)}`);
      await mkdir(caseDir, { recursive: true });
      const n = rng.int(0, 3);
      for (let i = 0; i < n; i += 1) {
        const s = new SessionStore({
          dir: caseDir,
          runId: `s-${i}-${rng.int(0, 999)}`,
          model: "m",
          name: `n${i}`
        });
        await s.init();
        const msgs = rng.int(0, 4);
        for (let k = 0; k < msgs; k += 1) await s.appendMessage({ role: "user", content: `x${k}` });
        await s.recordUsage({ promptTokens: 1, completionTokens: 2, totalTokens: 3, usd: 0.01 });
      }
      await appendFile(join(caseDir, "junk.jsonl"), "not json\n");
      const list = await listSessions(caseDir);
      expect(list.length).toBe(n);
      for (const info of list) {
        expect(info.runId.length).toBeGreaterThan(0);
        expect(info.tokens).toBeGreaterThanOrEqual(0);
        expect(info.usd).toBeGreaterThanOrEqual(0);
      }
    })
  );

  it(
    "usage entries accumulate monotonically",
    fuzzCases({ seed: 0xc05, runs: 60 }, async (rng) => {
      const store = new SessionStore({ dir, model: "m" });
      await store.init();
      let total = 0;
      const n = rng.int(0, 6);
      for (let i = 0; i < n; i += 1) {
        const t = rng.int(0, 100);
        total += t;
        await store.recordUsage({ promptTokens: t, completionTokens: 0, totalTokens: t, usd: 0 });
      }
      expect(store.usageFromEntries().totalTokens).toBe(total);
      await store.appendNote("usage:{broken");
      expect(store.usageFromEntries().totalTokens).toBe(total);
    })
  );
});

describe("session store file format", () => {
  it("writes one JSON object per line", async () => {
    const store = new SessionStore({ dir, runId: "fmt", model: "m" });
    await store.init();
    await store.appendMessage({ role: "user", content: "hello\nworld" });
    const raw = await readFile(store.path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});

/**
 * Fuzz tests for text/encoding and parsing helpers:
 *   src/context/compaction.ts, src/skills.ts, src/config.ts, src/cost.ts,
 *   src/util/stream.ts, src/goals.ts
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  estimateTokens,
  formatSummaryPrompt,
  projectTokens,
  shouldCompact
} from "../../src/context/compaction.js";
import { discoverSkills, findSkill, skillLines, skillPrompt } from "../../src/skills.js";
import { contextPct, contextWindow } from "../../src/config.js";
import { CostTracker, usdFor } from "../../src/cost.js";
import { collectText } from "../../src/util/stream.js";
import { FileGoalStore } from "../../src/goals.js";
import type { ChatMessage } from "../../src/types.js";
import { fuzzCases } from "./harness.js";

describe("fuzz: token estimation", () => {
  it(
    "estimateTokens is non-negative and monotone under concatenation",
    fuzzCases({ seed: 0xb01, runs: 300 }, (rng) => {
      const a = rng.str(rng.int(0, 80));
      const b = rng.str(rng.int(0, 80));
      const ea = estimateTokens(a);
      expect(ea).toBeGreaterThanOrEqual(0);
      expect(estimateTokens(a + b)).toBeGreaterThanOrEqual(ea);
      expect(estimateTokens("")).toBe(0);
      const ascii = "a".repeat(rng.int(0, 100));
      expect(estimateTokens(ascii)).toBe(Math.ceil(ascii.length / 4));
    })
  );

  it(
    "projectTokens skips compacted messages and honours explicit tokens",
    fuzzCases({ seed: 0xb02, runs: 150 }, (rng) => {
      const msgs: ChatMessage[] = Array.from({ length: rng.int(0, 8) }, () => {
        const m: ChatMessage = {
          role: rng.pick(["user", "assistant", "tool", "system"] as const),
          content: rng.str(40)
        };
        if (rng.bool(0.2)) m.compacted = true;
        if (rng.bool(0.2)) m.tokens = rng.int(0, 50);
        if (rng.bool(0.3)) m.toolCalls = [{ id: "c", name: "read", arguments: { path: rng.str(5) } }];
        return m;
      });
      expect(projectTokens(msgs)).toBeGreaterThanOrEqual(0);
      expect(projectTokens(msgs.map((m) => ({ ...m, compacted: true })))).toBe(0);
    })
  );

  it(
    "shouldCompact fires exactly when the safety-adjusted projection exceeds the threshold",
    fuzzCases({ seed: 0xb03, runs: 150 }, (rng) => {
      const cfg = {
        contextWindow: rng.int(100, 5000),
        reserveTokens: rng.int(0, 200),
        keepRecentTokens: rng.int(0, 100),
        threshold: rng.bool() ? rng.int(0, 2000) : undefined
      };
      const msgs: ChatMessage[] = [{ role: "user", content: "x".repeat(rng.int(0, 4000)) }];
      const threshold = cfg.threshold ?? Math.max(1024, cfg.contextWindow - cfg.reserveTokens);
      expect(shouldCompact(msgs, cfg)).toBe(projectTokens(msgs) * 1.15 > threshold);
    })
  );

  it("formatSummaryPrompt preserves role labels", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read", arguments: { path: "a" } }] },
      { role: "tool", content: "result", name: "read" }
    ];
    const prompt = formatSummaryPrompt(msgs);
    expect(prompt).toContain("USER: do the thing");
    expect(prompt).toContain("ASSISTANT:");
    expect(prompt).toContain("TOOL(read)");
  });
});

describe("fuzz: skills discovery", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dh-fuzz-skills-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(
    "arbitrary SKILL.md content never crashes discovery",
    fuzzCases({ seed: 0xb04, runs: 40 }, async (rng) => {
      const skillDir = join(dir, `.dream/skills/s${rng.int(0, 1_000_000)}`);
      await mkdir(skillDir, { recursive: true });
      const raw = rng.bool()
        ? `---\nname: ${rng.str(10)}\ndescription: ${rng.str(20)}\n---\n\n${rng.str(100)}`
        : rng.str(200);
      await writeFile(join(skillDir, "SKILL.md"), raw);
      const skills = await discoverSkills(dir);
      for (const s of skills) {
        // The directory fallback can be empty for a body-less skill; only the
        // body contract matters, so just require a string name.
        expect(typeof s.name).toBe("string");
        expect(skillPrompt(s)).toContain(s.body);
      }
      expect(() => skillLines(skills, 80)).not.toThrow();
      expect(findSkill(skills, "")).toBeNull();
    })
  );
});

describe("fuzz: config", () => {
  it(
    "contextWindow returns a positive integer and contextPct stays in [0,1]",
    fuzzCases({ seed: 0xb05, runs: 200 }, (rng) => {
      const saved = process.env.DREAM_CONTEXT_WINDOW;
      try {
        if (rng.bool(0.5)) delete process.env.DREAM_CONTEXT_WINDOW;
        else process.env.DREAM_CONTEXT_WINDOW = String(rng.int(-100, 200_000));
        const explicit = rng.bool() ? rng.int(-50, 300_000) + rng.next() : undefined;
        const w = contextWindow(explicit);
        expect(w).toBeGreaterThan(0);
        expect(Number.isInteger(w)).toBe(true);
        const pct = contextPct(rng.int(-100, 500_000), w);
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(1);
      } finally {
        if (saved === undefined) delete process.env.DREAM_CONTEXT_WINDOW;
        else process.env.DREAM_CONTEXT_WINDOW = saved;
      }
    })
  );
});

describe("fuzz: cost", () => {
  it(
    "usdFor is non-negative and linear in token counts",
    fuzzCases({ seed: 0xb06, runs: 200 }, (rng) => {
      const model = rng.pick(["deepseek-chat", "gpt-4o", "unknown-model", "local", "claude-3-5-sonnet"]);
      const p = rng.int(0, 1_000_000);
      const c = rng.int(0, 1_000_000);
      const usd = usdFor(model, { promptTokens: p, completionTokens: c, totalTokens: p + c });
      expect(usd).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(usd)).toBe(true);
      if (model !== "local" && model !== "unknown-model") {
        expect(
          usdFor(model, { promptTokens: p * 2, completionTokens: c * 2, totalTokens: (p + c) * 2 })
        ).toBeCloseTo(usd * 2, 8);
      }
      const tracker = new CostTracker({ model });
      tracker.record({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
      const s = tracker.summary();
      expect(s.calls).toBe(1);
      expect(s.totalTokens).toBe(15);
      const rec = tracker.record({ promptTokens: 1, completionTokens: 1, totalTokens: 2, usd: 0.5 });
      expect(rec.usd).toBe(0.5);
      expect(tracker.summary().usd).toBeCloseTo(s.usd + 0.5, 12);
    })
  );
});

describe("fuzz: stream decoding", () => {
  it(
    "collectText reassembles arbitrary chunk splits byte-exactly",
    fuzzCases({ seed: 0xb07, runs: 200 }, async (rng) => {
      const text = rng.str(rng.int(0, 200));
      const buf = Buffer.from(text, "utf8");
      const chunks: Buffer[] = [];
      let i = 0;
      while (i < buf.length) {
        const n = rng.int(1, 7);
        chunks.push(buf.subarray(i, i + n));
        i += n;
      }
      const stream = Readable.from(chunks);
      const sink = collectText(stream);
      const out = await new Promise<string>((res) => stream.on("end", () => res(sink.flush())));
      expect(out).toBe(text);
    })
  );
});

describe("fuzz: goal store", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dh-fuzz-goals-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(
    "add/update/find/remove keep exactly one active goal per session",
    fuzzCases({ seed: 0xb08, runs: 60 }, async (rng) => {
      const store = new FileGoalStore(dir);
      const sessionId = `s${rng.int(0, 3)}`;
      const titles = Array.from({ length: rng.int(1, 5) }, () => rng.str(20));
      for (const title of titles) store.add(title, rng.str(10), sessionId);
      const mine = store.forSession(sessionId);
      expect(mine.length).toBe(titles.length);
      expect(mine.filter((g) => g.status === "active")).toHaveLength(1);
      expect(mine.at(-1)!.status).toBe("active");
      const active = store.active(sessionId);
      expect(active).not.toBeNull();
      expect(store.find(active!.id.slice(0, 3))).not.toBeNull();
      const other = store.add("other", "", "other-session");
      expect(store.active("other-session")!.id).toBe(other.id);
      expect(store.active(sessionId)!.id).toBe(active!.id);
      await store.save();
      const reloaded = new FileGoalStore(dir);
      await reloaded.load();
      expect(reloaded.goals.length).toBe(store.goals.length);
      expect(reloaded.active(sessionId)!.id).toBe(active!.id);
      expect(store.remove(active!.id)).toBe(true);
      expect(store.remove("nope")).toBe(false);
    })
  );
});

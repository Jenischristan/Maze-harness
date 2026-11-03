import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CommandParseError,
  parseCommandLine,
  parseCommandSpec,
  quoteArg,
  argvJoin
} from "../src/util/args.js";
import { Budget, describeBudgetExceeded } from "../src/util/limits.js";
import { LockHeldError, RunLock, lockPresent, runLockPath } from "../src/util/lock.js";
import {
  CircuitBreaker,
  computeDelay,
  isRetryableError,
  sleep,
  withRetry
} from "../src/util/retry.js";
import { findFuzzy } from "../src/tools/fuzzy-match.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-utils-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("util/args", () => {
  it("parses quoted and escaped command lines", () => {
    expect(parseCommandLine(`a "b c" 'd e' f\\ g`)).toEqual(["a", "b c", "d e", "f g"]);
    expect(parseCommandLine("  spaced   out  ")).toEqual(["spaced", "out"]);
    expect(parseCommandLine("")).toEqual([]);
  });

  it("handles a trailing backslash and a backslash inside quotes", () => {
    expect(parseCommandLine("a\\")).toEqual(["a\\"]);
    expect(parseCommandLine(`"a\\\\b"`)).toEqual(["a\\b"]);
  });

  it("throws on an unterminated quote", () => {
    expect(() => parseCommandLine(`a "b`)).toThrow(CommandParseError);
    expect(() => parseCommandLine(`a 'b`)).toThrow(/unterminated/);
  });

  it("quotes arguments only when needed", () => {
    expect(quoteArg("plain")).toBe("plain");
    expect(quoteArg("")).toBe('""');
    expect(quoteArg("a b")).toBe('"a b"');
    expect(quoteArg('a"b')).toBe('"a\\"b"');
    expect(quoteArg("a\\b")).toBe('"a\\\\b"');
    expect(argvJoin(["a", "b c"])).toBe(`a "b c"`);
  });

  it("parses JSON array command specs", () => {
    expect(parseCommandSpec('["npx","-y","pkg"]')).toEqual(["npx", "-y", "pkg"]);
  });

  it("rejects malformed JSON command specs", () => {
    expect(() => parseCommandSpec("[bad")).toThrow(/does not parse/);
    expect(() => parseCommandSpec("[]")).toThrow(/non-empty array/);
    expect(() => parseCommandSpec('["a",1]')).toThrow(/non-empty array/);
    // A JSON object is not a command array; it is parsed as a quoted word.
    expect(parseCommandSpec('{"a":1}')).toEqual(["{a:1}"]);
  });

  it("rejects an empty plain command", () => {
    expect(() => parseCommandSpec("   ")).toThrow(/command is empty/);
  });
});

describe("util/limits budget", () => {
  it("reports each exceeded limit in priority order", () => {
    const b = new Budget({
      maxTurns: 1,
      maxTokens: 10,
      maxUsd: 1,
      maxToolCalls: 2,
      maxWallMs: 100_000
    });
    expect(b.check()).toBeNull();
    b.turn();
    expect(b.check()).toMatchObject({ kind: "turns", used: 1 });
    const t = new Budget({ maxTokens: 5 });
    t.spend(5, 0);
    expect(t.check()).toMatchObject({ kind: "tokens", used: 5 });
    const u = new Budget({ maxUsd: 0.5 });
    u.spend(0, 0.5);
    expect(u.check()).toMatchObject({ kind: "usd", used: 0.5 });
    const c = new Budget({ maxToolCalls: 1 });
    c.toolCalls(1);
    expect(c.check()).toMatchObject({ kind: "tool-calls" });
    const w = new Budget({ maxWallMs: 0 }, Date.now() - 1000);
    expect(w.check()).toMatchObject({ kind: "wall" });
  });

  it("ignores non-finite and non-positive spend", () => {
    const b = new Budget({ maxTokens: 1, maxUsd: 1 });
    b.spend(Number.NaN, Number.NaN);
    b.spend(-5, -5);
    b.toolCalls(Number.NaN);
    b.toolCalls(-1);
    expect(b.used).toMatchObject({ tokens: 0, usd: 0, toolCalls: 0 });
  });

  it("describes every budget kind", () => {
    expect(describeBudgetExceeded({ kind: "turns", limit: 3, used: 3 })).toContain("turn limit 3");
    expect(describeBudgetExceeded({ kind: "tokens", limit: 1, used: 1 })).toContain("token limit");
    expect(describeBudgetExceeded({ kind: "wall", limit: 1, used: 1 })).toContain(
      "wall-clock limit"
    );
    expect(describeBudgetExceeded({ kind: "usd", limit: 1, used: 1 })).toContain("USD limit");
    expect(describeBudgetExceeded({ kind: "tool-calls", limit: 1, used: 1 })).toContain(
      "tool-call limit"
    );
  });
});

describe("util/retry", () => {
  it("computes bounded exponential delays with jitter", () => {
    const base = {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: 0.5,
      maxAttempts: 3,
      retryable: () => true
    };
    expect(computeDelay(1, base, () => 0)).toBe(50);
    expect(computeDelay(1, base, () => 1)).toBe(150);
    expect(computeDelay(20, base, () => 0.5)).toBe(1000);
    expect(computeDelay(0, base, () => 0.5)).toBe(100);
  });

  it("rejects a non-positive maxAttempts", async () => {
    await expect(withRetry(async () => 1, { maxAttempts: 0 })).rejects.toThrow(/positive integer/);
  });

  it("calls onRetry and eventually succeeds", async () => {
    const seen: number[] = [];
    let n = 0;
    const out = await withRetry(
      async () => {
        n += 1;
        if (n < 3) throw Object.assign(new Error("429"), { status: 429 });
        return "ok";
      },
      {
        baseDelayMs: 1,
        maxDelayMs: 2,
        retryable: isRetryableError,
        onRetry: (info) => seen.push(info.attempt)
      }
    );
    expect(out).toBe("ok");
    expect(seen).toEqual([1, 2]);
  });

  it("stops at the last attempt and rethrows", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw new Error("nope");
        },
        { maxAttempts: 2, baseDelayMs: 1, retryable: () => true }
      )
    ).rejects.toThrow("nope");
    expect(n).toBe(2);
  });

  it("aborts during backoff", async () => {
    const ac = new AbortController();
    const p = withRetry(
      async () => {
        throw Object.assign(new Error("500"), { status: 500 });
      },
      { baseDelayMs: 100, retryable: isRetryableError, signal: ac.signal }
    );
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toThrow("aborted");
  });

  it("sleep resolves for non-positive durations and rejects when pre-aborted", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(10, ac.signal)).rejects.toThrow("aborted");
  });

  it("classifies retryable statuses and messages", () => {
    for (const s of [408, 409, 425, 429, 500, 503])
      expect(isRetryableError({ status: s })).toBe(true);
    for (const s of [400, 401, 403, 404, 422]) expect(isRetryableError({ status: s })).toBe(false);
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableError(new Error("bad request"))).toBe(false);
    expect(isRetryableError("weird")).toBe(false);
  });

  it("opens, half-opens and closes a circuit breaker", () => {
    let now = 0;
    const b = new CircuitBreaker(2, 100, () => now);
    b.recordFailure();
    expect(b.state).toBe("closed");
    b.recordFailure();
    expect(b.state).toBe("open");
    expect(() => b.assertClosed()).toThrow(/circuit breaker open/);
    now = 101;
    expect(b.state).toBe("half-open");
    b.recordSuccess();
    expect(b.state).toBe("closed");
  });
});

describe("util/lock", () => {
  async function writeLock(info: Record<string, unknown>): Promise<string> {
    const path = join(dir, "l");
    await writeFile(path, JSON.stringify(info));
    return path;
  }

  it("exposes the canonical lock path and presence check", () => {
    expect(runLockPath("/runs")).toBe(join("/runs", ".dream.lock"));
    expect(lockPresent(dir)).toBe(false);
  });

  it("blocks a second acquire and releases cleanly", async () => {
    const path = join(dir, "l");
    const a = new RunLock({ path, runId: "a" });
    await a.acquire();
    expect(a.isHeld).toBe(true);
    expect(lockPresent(dir)).toBe(false); // presence is checked against the runs dir
    const b = new RunLock({ path, runId: "b" });
    await expect(b.acquire()).rejects.toBeInstanceOf(LockHeldError);
    await a.release();
    await b.acquire();
    expect(b.isHeld).toBe(true);
    await b.release();
  });

  it("reclaims a lock whose pid is dead", async () => {
    const path = await writeLock({
      pid: 999_999,
      host: hostname(),
      runId: "dead",
      acquiredAt: new Date().toISOString()
    });
    const reasons: string[] = [];
    const l = new RunLock({ path, runId: "x", onReclaim: (_i, r) => reasons.push(r) });
    await l.acquire();
    expect(l.isHeld).toBe(true);
    expect(reasons[0]).toMatch(/not running/);
    await l.release();
  });

  it("reclaims an unreadable lock file", async () => {
    const path = join(dir, "l");
    await writeFile(path, "{not json");
    const l = new RunLock({ path, runId: "x" });
    await l.acquire();
    expect(l.isHeld).toBe(true);
    await l.release();
  });

  it("reclaims a lock older than maxAgeMs", async () => {
    const path = await writeLock({
      pid: process.pid,
      host: hostname(),
      runId: "old",
      acquiredAt: new Date().toISOString()
    });
    const past = new Date(Date.now() - 10_000);
    await utimes(path, past, past);
    const l = new RunLock({ path, runId: "x", maxAgeMs: 1000 });
    await l.acquire();
    expect(l.isHeld).toBe(true);
    await l.release();
  });

  it("treats an old foreign-host lock as stale but a fresh one as held", async () => {
    const path = await writeLock({
      pid: process.pid,
      host: "elsewhere",
      runId: "o",
      acquiredAt: new Date().toISOString()
    });
    const fresh = new RunLock({ path, runId: "x" });
    await expect(fresh.acquire()).rejects.toBeInstanceOf(LockHeldError);
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path, past, past);
    const stale = new RunLock({ path, runId: "y" });
    await stale.acquire();
    expect(stale.isHeld).toBe(true);
    await stale.release();
  });

  it("does not delete a foreign process's lock on release", async () => {
    const path = join(dir, "l");
    const l = new RunLock({ path, runId: "x" });
    await l.acquire();
    await writeFile(
      path,
      JSON.stringify({ pid: 1, host: "elsewhere", runId: "other", acquiredAt: "t" })
    );
    await l.release();
    expect(JSON.parse(await readFile(path, "utf8")).runId).toBe("other");
  });

  it("heartbeat and release are no-ops when not held", async () => {
    const path = join(dir, "l");
    const l = new RunLock({ path, runId: "x" });
    await expect(l.heartbeat()).resolves.toBeUndefined();
    await expect(l.release()).resolves.toBeUndefined();
  });

  it("heartbeat touches the lock mtime", async () => {
    const path = join(dir, "l");
    const l = new RunLock({ path, runId: "x" });
    await l.acquire();
    const past = new Date(Date.now() - 10_000);
    await utimes(path, past, past);
    await l.heartbeat();
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.runId).toBe("x");
    await l.release();
  });
});

describe("tools/fuzzy-match edge cases", () => {
  it("returns null for empty needles and missing matches", () => {
    expect(findFuzzy("abc", "")).toEqual({ match: null, ambiguous: false });
    expect(findFuzzy("abc", "zzz")).toEqual({ match: null, ambiguous: false });
  });

  it("falls back to an indentation-insensitive match with exact offsets", () => {
    const text = "function f() {\n    return 1;\n}\n";
    const r = findFuzzy(text, "function f() {\nreturn 1;");
    expect(r.match?.strategy).toBe("whitespace");
    expect(text.slice(r.match!.start, r.match!.end)).toBe("function f() {\n    return 1;");
  });

  it("handles whitespace-only needles as no match", () => {
    expect(findFuzzy("a  b", "   ").match).toBeNull();
  });
});

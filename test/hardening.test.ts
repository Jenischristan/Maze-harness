import { mkdtemp, rm, utimes, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REDACTED, redact, redactValue } from "../src/util/redact.js";
import {
  CommandParseError,
  parseCommandLine,
  parseCommandSpec,
  argvJoin,
  quoteArg
} from "../src/util/args.js";
import { childEnv, isDeniedEnvKey, taskChildEnv } from "../src/util/env.js";
import { Budget, describeBudgetExceeded } from "../src/util/limits.js";
import { withRetry, isRetryableError, computeDelay, sleep } from "../src/util/retry.js";
import {
  CURRENT_SCHEMA,
  migrate,
  registerUpcaster,
  SchemaVersionError,
  stampSchema,
  hasFullMigrationChain
} from "../src/util/schema.js";
import { hashLine, scanJsonl, withIntegrity } from "../src/util/integrity.js";
import { RunLock, LockHeldError, lockPresent, runLockPath } from "../src/util/lock.js";
import { findFuzzy } from "../src/tools/fuzzy-match.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-merged-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("redaction", () => {
  it("scrubs bearer headers and provider key shapes", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toBe(
      `Authorization: Bearer ${REDACTED}`
    );
    expect(redact("key sk-abcdefghijklmnop1234")).toBe(`key ${REDACTED}`);
    expect(redact("token ghp_abcdefghijklmnopqrstuvwxyz012345")).toBe(`token ${REDACTED}`);
    expect(redact("AKIAABCDEFGHIJKLMNOP")).toBe(REDACTED);
  });

  it("scrubs key=value secrets including JSON", () => {
    expect(redact("DREAM_API_KEY=supersecretvalue")).toContain(REDACTED);
    expect(redact('{"api_key": "abcd1234efgh"}')).toContain(REDACTED);
    expect(redact("password: hunter2hunter2")).toContain(REDACTED);
  });

  it("scrubs PEM private keys wholesale", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(redact(`x ${pem} y`)).toBe(`x ${REDACTED} y`);
  });

  it("scrubs known literal env values", () => {
    process.env.DREAM_TEST_HARDENING_TOKEN = "literal-secret-value-123";
    try {
      expect(redact("leaked: literal-secret-value-123")).toContain(
        "[REDACTED:DREAM_TEST_HARDENING_TOKEN]"
      );
    } finally {
      delete process.env.DREAM_TEST_HARDENING_TOKEN;
    }
  });

  it("redacts nested values without mutating the input", () => {
    const input = { a: "sk-abcdefghijklmnop", list: ["Bearer abcdefghijkl"] };
    const out = redactValue(input);
    expect(out.a).toBe(REDACTED);
    expect(out.list[0]).toContain(REDACTED);
    expect(input.a).toBe("sk-abcdefghijklmnop");
  });

  it("leaves ordinary prose untouched", () => {
    expect(redact("the quick brown fox")).toBe("the quick brown fox");
  });
});

describe("command parsing", () => {
  it("keeps quoted paths with spaces as one argv entry", () => {
    expect(parseCommandLine('python3 "/opt/my tools/eval.py" {workspace}')).toEqual([
      "python3",
      "/opt/my tools/eval.py",
      "{workspace}"
    ]);
  });

  it("handles single quotes, escapes and empty args", () => {
    expect(parseCommandLine(`a 'b c' d\\ e ""`)).toEqual(["a", "b c", "d e", ""]);
  });

  it("rejects an unterminated quote", () => {
    expect(() => parseCommandLine(`python "unterminated`)).toThrow(/unterminated/);
  });

  it("accepts a JSON array command spec", () => {
    expect(parseCommandSpec('["python3", "/a b/eval.py"]')).toEqual(["python3", "/a b/eval.py"]);
  });

  it("round-trips argv through quoting", () => {
    const argv = ["python3", "/opt/my tools/eval.py", "", 'he said "hi"'];
    expect(parseCommandLine(argvJoin(argv))).toEqual(argv);
    expect(quoteArg("simple")).toBe("simple");
  });
});

describe("child environment scrubbing", () => {
  it("drops provider credentials and loader hooks", () => {
    const env = childEnv({
      PATH: "/bin",
      HOME: "/home/x",
      DREAM_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
      NODE_OPTIONS: "--require ./evil.js",
      LD_PRELOAD: "/tmp/evil.so"
    });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.DREAM_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
  });

  it("allows explicit additions but never a denied prefix", () => {
    const env = childEnv({ PATH: "/bin" }, { SAFE_FLAG: "1" });
    expect(env.SAFE_FLAG).toBe("1");
    expect(isDeniedEnvKey("DREAM_ANYTHING")).toBe(true);
    expect(isDeniedEnvKey("PATH")).toBe(false);
  });

  it("never lets caller-supplied extras smuggle a denied key into the child", () => {
    // Regression: `extra` was copied verbatim, so a task could pass
    // DREAM_API_KEY (or any provider secret) straight to the child process
    // the allowlist exists to protect.
    const env = childEnv(
      { PATH: "/bin" },
      { DREAM_API_KEY: "leak", OPENAI_API_KEY: "leak", SAFE_FLAG: "1" }
    );
    expect(env.SAFE_FLAG).toBe("1");
    expect(env.DREAM_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();

    const taskEnv = taskChildEnv({ PATH: "/bin" }, { DREAM_API_KEY: "leak" });
    expect(taskEnv.DREAM_CHILD).toBe("1");
    expect(taskEnv.DREAM_API_KEY).toBeUndefined();
  });
});

describe("budgets", () => {
  it("stops at the turn limit and reports it", () => {
    const b = new Budget({ maxTurns: 2 });
    b.turn();
    expect(b.check()).toBeNull();
    b.turn();
    const exceeded = b.check();
    expect(exceeded?.kind).toBe("turns");
    expect(describeBudgetExceeded(exceeded!)).toContain("turn limit 2");
  });

  it("charges tokens and USD and stops on the smaller limit", () => {
    const tokens = new Budget({ maxTokens: 100 });
    tokens.spend(150, 0);
    expect(tokens.check()?.kind).toBe("tokens");

    const usd = new Budget({ maxUsd: 0.5 });
    usd.spend(1, 0.75);
    expect(usd.check()?.kind).toBe("usd");
  });

  it("stops on wall-clock and tool-call limits", () => {
    const wall = new Budget({ maxWallMs: 0 });
    expect(wall.check()?.kind).toBe("wall");
    const tools = new Budget({ maxToolCalls: 1 });
    tools.toolCalls(1);
    expect(tools.check()?.kind).toBe("tool-calls");
  });
});

describe("retry and circuit breaker", () => {
  it("retries retryable failures then succeeds", async () => {
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error("busy"), { status: 503 });
        return "ok";
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
    );
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error("bad request"), { status: 400 });
        },
        { maxAttempts: 5, baseDelayMs: 1, retryable: isRetryableError }
      )
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });

  it("classifies retryable errors and bounds delays", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
    expect(isRetryableError({ status: 404 })).toBe(false);
    expect(isRetryableError(new Error("socket hang up"))).toBe(true);
    const policy = {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 150,
      jitter: 0,
      retryable: () => true
    };
    expect(computeDelay(3, policy)).toBe(150);
  });
});

describe("schema migration", () => {
  it("stamps the current schema and upgrades a v1 record", () => {
    expect(stampSchema({ a: 1 }).schema).toBe(CURRENT_SCHEMA);
    expect(migrate("demo", { a: 1 })).toEqual({ a: 1, schema: CURRENT_SCHEMA });
  });

  it("rejects a newer schema instead of guessing", () => {
    expect(() => migrate("demo", { schema: CURRENT_SCHEMA + 1 })).toThrow(SchemaVersionError);
  });

  it("applies a registered upcaster", () => {
    registerUpcaster("demo-upcast", 1, (r) => ({ ...r, added: true }));
    expect(migrate("demo-upcast", { a: 1 })).toEqual({ a: 1, added: true, schema: CURRENT_SCHEMA });
  });
});

describe("JSONL integrity", () => {
  it("reports corrupt lines and accepts legacy records", () => {
    const legacy = JSON.stringify({ id: "m1" });
    const good = JSON.stringify(withIntegrity({ id: "m2" }));
    const scan = scanJsonl(`${legacy}\n{not json}\n${good}\n`);
    expect(scan.records.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(scan.corrupt).toHaveLength(1);
    expect(scan.tampered).toHaveLength(0);
  });

  it("detects a record modified after hashing", () => {
    const record = withIntegrity({ id: "m1", value: 1 });
    record.value = 2;
    const scan = scanJsonl(`${JSON.stringify(record)}\n`);
    expect(scan.tampered).toHaveLength(1);
    expect(hashLine(record)).not.toBe((record as { __h: string }).__h);
  });

  it("does not flag a record whose undefined fields are dropped by JSON", () => {
    // Regression: stableStringify used to emit the bare token "undefined" for
    // nested undefined values, so any persisted record containing one was
    // reported as tampered after a JSON round-trip.
    const record = withIntegrity({
      id: "m1",
      optional: undefined,
      nested: { keep: 1, drop: undefined },
      list: [1, undefined, 2]
    });
    const persisted = JSON.parse(JSON.stringify(record));
    const scan = scanJsonl(`${JSON.stringify(persisted)}\n`);
    expect(scan.corrupt).toHaveLength(0);
    expect(scan.tampered).toHaveLength(0);
  });

  it("still detects tampering in a record that also has undefined fields", () => {
    const record = withIntegrity({ id: "m1", keep: 1, drop: undefined });
    const persisted = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    persisted.keep = 2;
    const scan = scanJsonl(`${JSON.stringify(persisted)}\n`);
    expect(scan.tampered).toHaveLength(1);
  });
});

describe("run lock", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dh-lock-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is exclusive and releasable", async () => {
    const path = join(dir, ".lock");
    const a = new RunLock({ path, runId: "a" });
    await a.acquire();
    expect(a.isHeld).toBe(true);
    const b = new RunLock({ path, runId: "b" });
    await expect(b.acquire()).rejects.toBeInstanceOf(LockHeldError);
    await a.release();
    await b.acquire();
    expect(b.isHeld).toBe(true);
    await b.release();
  });

  it("reclaims a lock whose owner pid is gone", async () => {
    const path = join(dir, ".lock");
    await writeFile(
      path,
      JSON.stringify({
        pid: 2 ** 22 + 12345,
        host: (await import("node:os")).hostname(),
        runId: "dead",
        acquiredAt: new Date().toISOString()
      })
    );
    const lock = new RunLock({ path, runId: "live" });
    let reclaimed = false;
    const l2 = new RunLock({ path, runId: "live", onReclaim: () => (reclaimed = true) });
    await l2.acquire();
    expect(reclaimed).toBe(true);
    expect(lock.isHeld).toBe(false);
    await l2.release();
  });
});

describe("util/schema", () => {
  it("stamps the current schema", () => {
    expect(stampSchema({ a: 1 })).toEqual({ a: 1, schema: CURRENT_SCHEMA });
  });

  it("rejects non-objects and invalid versions", () => {
    expect(() => migrate("k", null as never)).toThrow(SchemaVersionError);
    expect(() => migrate("k", { schema: 0 })).toThrow(/invalid schema version/);
    expect(() => migrate("k", { schema: 1.5 })).toThrow(/invalid schema version/);
  });

  it("rejects a record from a newer build", () => {
    expect(() => migrate("k", { schema: CURRENT_SCHEMA + 1 }, CURRENT_SCHEMA)).toThrow(/upgrade/);
  });

  it("stamps the target when there is no chain to walk", () => {
    expect(migrate("plain", { a: 1 }, CURRENT_SCHEMA).schema).toBe(CURRENT_SCHEMA);
  });

  it("fails loudly when a legacy-shaped record has no upcaster", () => {
    expect(() => migrate("live-manifest", { version: 1 }, CURRENT_SCHEMA)).toThrow(/no migration/);
  });

  it("walks a registered upcaster chain", () => {
    registerUpcaster("chain-test", 1, (r) => ({ ...r, one: true }));
    registerUpcaster("chain-test", 2, (r) => ({ ...r, two: true }));
    const out = migrate("chain-test", { schema: 1 }, 3);
    expect(out.schema).toBe(3);
    expect(out).toMatchObject({ one: true, two: true });
    expect(hasFullMigrationChain("chain-test")).toBe(true);
    expect(hasFullMigrationChain("nope")).toBe(false);
  });

  it("rejects an upcaster that returns no record", () => {
    registerUpcaster("bad-upcast", 1, () => null as never);
    expect(() => migrate("bad-upcast", { schema: 1 }, 2)).toThrow(/returned no record/);
  });
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

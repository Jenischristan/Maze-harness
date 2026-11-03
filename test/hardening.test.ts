import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REDACTED, redact, redactValue } from "../src/util/redact.js";
import { parseCommandLine, parseCommandSpec, argvJoin, quoteArg } from "../src/util/args.js";
import { childEnv, isDeniedEnvKey } from "../src/util/env.js";
import { Budget, describeBudgetExceeded } from "../src/util/limits.js";
import { withRetry, isRetryableError, computeDelay } from "../src/util/retry.js";
import {
  CURRENT_SCHEMA,
  migrate,
  registerUpcaster,
  SchemaVersionError,
  stampSchema
} from "../src/util/schema.js";
import { hashLine, scanJsonl, withIntegrity } from "../src/util/integrity.js";
import { RunLock, LockHeldError } from "../src/util/lock.js";

/**
 * Pins the production-hardening primitives. Each one replaced an unsafe or
 * ad hoc behaviour, so the tests assert the safety property, not the shape:
 * a secret never survives, an argv never splits a quoted path, a child never
 * inherits a key, a budget stops before overshooting, and a lock is exclusive.
 */

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

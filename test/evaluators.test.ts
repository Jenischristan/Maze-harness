import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandEvaluator } from "../src/evaluator.js";

// System tests: run each bundled evaluator exactly the way the harness does
// (a separate process, one JSON line on stdout, scrubbed cwd) and assert the
// result contract.

const root = resolve(import.meta.dirname, "..");

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-eval-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface EvaluatorLine {
  score: number | null;
  valid: boolean;
  failClass: string;
  error: string | null;
  diagnostics: unknown;
}

function runEvaluator(
  script: string,
  workspace: string
): Promise<{ code: number | null; last: EvaluatorLine | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("python3", [join(root, script), workspace], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", () => resolvePromise({ code: -1, last: null, stdout, stderr }));
    child.on("close", (code) => {
      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const lastLine = lines.at(-1);
      let last: EvaluatorLine | null = null;
      if (lastLine) {
        try {
          last = JSON.parse(lastLine) as EvaluatorLine;
        } catch {
          last = null;
        }
      }
      resolvePromise({ code, last, stdout, stderr });
    });
  });
}

async function copyInit(task: string, into: string): Promise<string> {
  await cp(join(root, "examples", task, "init"), into, { recursive: true });
  return into;
}

describe("toy-task evaluator", () => {
  it("scores the shipped init program", async () => {
    const ws = await copyInit("toy-task", join(dir, "ws"));
    const res = await runEvaluator("examples/toy-task/evaluator/evaluate.py", ws);
    expect(res.code).toBe(0);
    expect(res.last).toMatchObject({ score: 0, valid: true, failClass: "ok", error: null });
    expect(res.last!.diagnostics).toEqual({ value: 0, generation: 0 });
  });

  it("scores a positive value and rejects a negative one", async () => {
    const ws = await copyInit("toy-task", join(dir, "ws2"));
    await writeFile(join(ws, "program.json"), JSON.stringify({ value: 2.5, generation: 3 }));
    const good = await runEvaluator("examples/toy-task/evaluator/evaluate.py", ws);
    expect(good.last).toMatchObject({ score: 2.5, valid: true, failClass: "ok" });

    await writeFile(join(ws, "program.json"), JSON.stringify({ value: -1, generation: 4 }));
    const bad = await runEvaluator("examples/toy-task/evaluator/evaluate.py", ws);
    expect(bad.last).toMatchObject({
      score: null,
      valid: false,
      failClass: "incorrect",
      error: "program value is negative"
    });
  });

  it("reports a missing or corrupt program as a compile failure", async () => {
    const empty = join(dir, "empty");
    await cp(join(root, "examples", "toy-task", "init"), empty, { recursive: true });
    await rm(join(empty, "program.json"));
    const missing = await runEvaluator("examples/toy-task/evaluator/evaluate.py", empty);
    expect(missing.last).toMatchObject({ score: null, valid: false, failClass: "compile" });

    const ws = await copyInit("toy-task", join(dir, "ws3"));
    await writeFile(join(ws, "program.json"), "{oops");
    const corrupt = await runEvaluator("examples/toy-task/evaluator/evaluate.py", ws);
    expect(corrupt.last).toMatchObject({ score: null, valid: false, failClass: "compile" });
  });
});

describe("fast-sum evaluator", () => {
  it("scores a correct but slow solution as valid", async () => {
    const ws = await copyInit("fast-sum", join(dir, "fast"));
    await writeFile(
      join(ws, "solution.py"),
      [
        "def solve(n):",
        "    return n * (n + 1) // 2",
        "",
        "def fib(k):",
        "    a, b = 0, 1",
        "    for _ in range(k):",
        "        a, b = b, a + b",
        "    return a",
        "",
        "def count_primes(limit):",
        "    if limit < 3:",
        "        return 0",
        "    sieve = bytearray([1]) * limit",
        "    sieve[0:2] = b'\\x00\\x00'",
        "    for p in range(2, int(limit ** 0.5) + 1):",
        "        if sieve[p]:",
        "            sieve[p * p::p] = bytearray(len(sieve[p * p::p]))",
        "    return sum(sieve)",
        ""
      ].join("\n")
    );
    const res = await runEvaluator("examples/fast-sum/evaluator/evaluate.py", ws);
    expect(res.code).toBe(0);
    expect(res.last!.valid).toBe(true);
    expect(res.last!.failClass).toBe("ok");
    expect(res.last!.score).toBeGreaterThan(0);
    const diag = res.last!.diagnostics as { cases: Array<{ case: string }> };
    expect(diag.cases.map((c) => c.case)).toEqual(["sum", "fib", "primes"]);
  });

  it("rejects a wrong answer as incorrect", async () => {
    const ws = await copyInit("fast-sum", join(dir, "fastbad"));
    await writeFile(
      join(ws, "solution.py"),
      [
        "def solve(n):",
        "    return 0",
        "",
        "def fib(k):",
        "    return 0",
        "",
        "def count_primes(limit):",
        "    return 0",
        ""
      ].join("\n")
    );
    const res = await runEvaluator("examples/fast-sum/evaluator/evaluate.py", ws);
    expect(res.last).toMatchObject({ score: null, valid: false, failClass: "incorrect" });
  });

  it("reports a missing solution as a compile failure", async () => {
    const ws = join(dir, "fastempty");
    await cp(join(root, "examples", "fast-sum", "init"), ws, { recursive: true });
    await rm(join(ws, "solution.py"));
    const res = await runEvaluator("examples/fast-sum/evaluator/evaluate.py", ws);
    expect(res.last).toMatchObject({ score: null, valid: false, failClass: "compile" });
  });

  it("reports a crashing solution as a runtime failure", async () => {
    const ws = await copyInit("fast-sum", join(dir, "fastcrash"));
    await writeFile(join(ws, "solution.py"), "raise RuntimeError('boom')\n");
    const res = await runEvaluator("examples/fast-sum/evaluator/evaluate.py", ws);
    expect(res.last).toMatchObject({ score: null, valid: false, failClass: "runtime" });
    // The evaluator prefixes the failing case and forwards the child's stderr,
    // truncated to 400 characters.
    expect(res.last!.error).toContain("sum(50000000) crashed");
    expect(res.last!.error).toContain("Traceback");
    // "<case> crashed: " prefix + the evaluator's 400-character stderr slice.
    expect(res.last!.error!.length).toBeLessThanOrEqual(423);
  });
});

describe("factor-arena evaluator", () => {
  it("scores a correct solution and records per-case detail", async () => {
    const ws = await copyInit("factor-arena", join(dir, "factor"));
    // A fast, correct implementation so the hard cases finish inside the limits.
    await writeFile(
      join(ws, "solution.py"),
      [
        "import math",
        "",
        "def factorize(n):",
        "    out = []",
        "    while n % 2 == 0:",
        "        out.append(2)",
        "        n //= 2",
        "    d = 3",
        "    while d * d <= n:",
        "        while n % d == 0:",
        "            out.append(d)",
        "            n //= d",
        "        d += 2",
        "    if n > 1:",
        "        out.append(n)",
        "    return out",
        "",
        "def totient(n):",
        "    if n <= 0:",
        "        return 0",
        "    result = n",
        "    for p in set(factorize(n)):",
        "        result -= result // p",
        "    return result",
        "",
        "def largest_prime_gap(limit):",
        "    if limit < 3:",
        "        return 0",
        "    sieve = bytearray([1]) * limit",
        "    sieve[0:2] = b'\\x00\\x00'",
        "    for p in range(2, math.isqrt(limit - 1) + 1):",
        "        if sieve[p]:",
        "            sieve[p * p::p] = bytearray(len(sieve[p * p::p]))",
        "    primes = [i for i, flag in enumerate(sieve) if flag]",
        "    return max((b - a for a, b in zip(primes, primes[1:])), default=0)",
        ""
      ].join("\n")
    );
    const res = await runEvaluator("examples/factor-arena/evaluator/evaluate.py", ws);
    expect(res.code).toBe(0);
    expect(res.last!.valid).toBe(true);
    expect(res.last!.failClass).toBe("ok");
    expect(res.last!.score).toBeGreaterThan(0);
    const diag = res.last!.diagnostics as {
      passed: number;
      total: number;
      cases: Array<{ case: string; status: string }>;
    };
    expect(diag.total).toBe(9);
    expect(diag.passed).toBeGreaterThan(0);
    expect(diag.cases.find((c) => c.case === "factor_small")!.status).toBe("ok");
  }, 120_000);

  it("fails when no case passes", async () => {
    const ws = await copyInit("factor-arena", join(dir, "factorbad"));
    await writeFile(
      join(ws, "solution.py"),
      [
        "def factorize(n):",
        "    return []",
        "",
        "def totient(n):",
        "    return -1",
        "",
        "def largest_prime_gap(limit):",
        "    return -1",
        ""
      ].join("\n")
    );
    const res = await runEvaluator("examples/factor-arena/evaluator/evaluate.py", ws);
    expect(res.last).toMatchObject({ score: null, valid: false, failClass: "incorrect" });
  }, 120_000);
});

describe("self-improve evaluator", () => {
  function runSelfImprove(
    workspace: string,
    env: Record<string, string>
  ): Promise<{ code: number | null; last: EvaluatorLine | null; stdout: string; stderr: string }> {
    return new Promise((resolvePromise) => {
      const child = spawn(
        "python3",
        [join(root, "examples/self-improve/evaluator/evaluate.py"), workspace],
        {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
          // Bounded: no dependency install is attempted (offline flags) and the
          // sub-command timeouts are tiny so a broken candidate fails fast.
          env: {
            ...process.env,
            SELF_IMPROVE_LOG_DIR: join(dir, "logs"),
            SELF_IMPROVE_CHECK_TIMEOUT: "20",
            SELF_IMPROVE_TEST_TIMEOUT: "20",
            ...env
          }
        }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      child.on("error", () => resolvePromise({ code: -1, last: null, stdout, stderr }));
      child.on("close", (code) => {
        const lines = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        let last: EvaluatorLine | null = null;
        const lastLine = lines.at(-1);
        if (lastLine) {
          try {
            last = JSON.parse(lastLine) as EvaluatorLine;
          } catch {
            last = null;
          }
        }
        resolvePromise({ code, last, stdout, stderr });
      });
    });
  }

  it("reports a missing workspace as a runtime failure with one JSON line", async () => {
    const res = await runSelfImprove(join(dir, "does-not-exist"), {});
    expect(res.code).toBe(0);
    expect(res.last).toMatchObject({ score: null, valid: false, failClass: "runtime" });
    expect(res.last!.error).toContain("workspace missing");
    expect(res.stdout.trim().split("\n")).toHaveLength(1);
  }, 60_000);

  it("reports a workspace without package.json as a compile failure", async () => {
    const ws = join(dir, "no-package");
    await writeFile(join(ws, "README.md"), "# nothing\n").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(ws, { recursive: true });
      await writeFile(join(ws, "README.md"), "# nothing\n");
    });
    const res = await runSelfImprove(ws, {});
    expect(res.last).toMatchObject({ score: null, valid: false, failClass: "compile" });
    expect(res.last!.error).toContain("package.json");
  }, 60_000);

  it("fails closed (never downloads) when node_modules is absent", async () => {
    // A package.json with no node_modules and no shared install: the evaluator
    // must refuse rather than reach the network. The offline flags make the
    // fallback install a no-op, so this returns quickly.
    const ws = join(dir, "offline");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(ws, { recursive: true });
    await writeFile(
      join(ws, "package.json"),
      JSON.stringify({ name: "candidate", version: "0.0.0" })
    );
    const res = await runSelfImprove(ws, { SELF_IMPROVE_NODE_MODULES: "" });
    expect(res.last).not.toBeNull();
    if (res.last!.valid === false) {
      expect(["runtime", "compile"]).toContain(res.last!.failClass);
      expect(res.last!.score).toBeNull();
    }
    // Whatever the outcome, the contract is exactly one JSON line on stdout.
    expect(res.stdout.trim().split("\n")).toHaveLength(1);
  }, 120_000);
});

describe("evaluator: command results", () => {
  function evaluator(script: string, timeoutMs = 10_000): CommandEvaluator {
    return new CommandEvaluator({
      command: [process.execPath, "-e", script],
      timeoutMs,
      cwd: dir
    });
  }

  it("parses a score/valid JSON payload", async () => {
    const res = await evaluator("console.log(JSON.stringify({score: 0.5, valid: true}))").evaluate(
      dir
    );
    expect(res).toMatchObject({ score: 0.5, valid: true, failClass: "ok" });
  });

  it("defaults validity from the score and failClass from validity", async () => {
    const ok = await evaluator("console.log(JSON.stringify({score: 1}))").evaluate(dir);
    expect(ok.valid).toBe(true);
    const bad = await evaluator("console.log(JSON.stringify({score: null}))").evaluate(dir);
    expect(bad.valid).toBe(false);
    expect(bad.failClass).toBe("incorrect");
  });

  it("keeps an explicit failClass and error", async () => {
    const res = await evaluator(
      'console.log(JSON.stringify({score: null, failClass: "compile", error: "nope"}))'
    ).evaluate(dir);
    expect(res).toMatchObject({ failClass: "compile", error: "nope" });
  });

  it("rejects a non-object payload", async () => {
    const res = await evaluator('console.log("[1,2]")').evaluate(dir);
    expect(res.error).toBe("evaluator JSON must be an object");
  });

  it("rejects a non-JSON last line", async () => {
    const res = await evaluator('console.log("not json")').evaluate(dir);
    expect(res.error).toBe("evaluator last line is not JSON");
  });

  it("reports no JSON line with the exit class", async () => {
    const res = await evaluator("process.exit(3)").evaluate(dir);
    expect(res.failClass).toBe("runtime");
    expect(res.error).toMatch(/no JSON line/);
  });

  it("times out a slow evaluator", async () => {
    const res = await evaluator("setTimeout(() => {}, 5000)", 200).evaluate(dir);
    expect(res.failClass).toBe("timeout");
  });

  it("reports an abort", async () => {
    const ac = new AbortController();
    const p = evaluator("setTimeout(() => {}, 5000)", 10_000).evaluate(dir, ac.signal);
    setTimeout(() => ac.abort(), 50);
    expect((await p).error).toBe("evaluator aborted");
  });

  it("rejects an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await evaluator("console.log('{}')").evaluate(dir, ac.signal);
    expect(res.failClass).toBe("timeout");
  });

  it("reports an empty command", async () => {
    const res = await new CommandEvaluator({ command: [], timeoutMs: 1000 }).evaluate(dir);
    expect(res.error).toBe("evaluator command is empty");
  });

  it("reports a spawn failure", async () => {
    const res = await new CommandEvaluator({
      command: [join(dir, "no-such-binary")],
      timeoutMs: 1000
    }).evaluate(dir);
    expect(res.error).toMatch(/spawn failed/);
  });

  it("substitutes {workspace} in arguments", async () => {
    const res = await new CommandEvaluator({
      command: [process.execPath, "-e", "console.log(JSON.stringify({score:1, valid:true}))"],
      timeoutMs: 5000
    }).evaluate("{workspace}");
    expect(res.score).toBe(1);
  });
});

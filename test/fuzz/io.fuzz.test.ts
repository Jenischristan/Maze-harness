/**
 * Fuzz + property tests for process/IO boundaries:
 *   src/evaluator.ts, src/tools/hooks.ts, src/util/atomic.ts,
 *   src/workspace/diff.ts, src/mcp.ts (config loading only)
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandEvaluator } from "../../src/evaluator.js";
import { Hooks, verifyCommandsToHooks } from "../../src/tools/hooks.js";
import { appendLineSafe, writeFileAtomic } from "../../src/util/atomic.js";
import { loadMcpConfig } from "../../src/mcp.js";
import { fuzzCases } from "./harness.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-fuzz-io-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fuzz: evaluator JSON parsing", () => {
  it(
    "arbitrary last-line JSON never crashes and always yields a well-formed result",
    fuzzCases({ seed: 0xe01, runs: 60, maxRuns: 60 }, async (rng) => {
      const payloads = [
        "{}",
        '{"score": 1}',
        '{"score": "high", "valid": true}',
        '{"score": 2, "valid": false, "failClass": "compile"}',
        '{"score": null, "error": "boom"}',
        '{"score": 1e999}',
        '{"score": NaN}',
        "[]",
        "null",
        "42",
        "not json",
        ""
      ];
      const chosen = rng.pick(payloads);
      // Feed the payload on stdin instead of interpolating it into a shell
      // string: the old form passed a JSON-quoted *string literal* to
      // process.stdout.write, so the evaluator saw `"{\"score\":1}"` rather
      // than the JSON object and never parsed a score.
      const payloadPath = join(dir, "payload.txt");
      await writeFile(payloadPath, chosen);
      const ev = new CommandEvaluator({
        command: ["cat", payloadPath],
        timeoutMs: 5000
      });
      const res = await ev.evaluate(dir);
      expect(typeof res.valid).toBe("boolean");
      expect(typeof res.failClass).toBe("string");
      if (res.score !== null) expect(Number.isFinite(res.score)).toBe(true);
      if (chosen === '{"score": 1}') expect(res.score).toBe(1);
      if (chosen === '{"score": 2, "valid": false, "failClass": "compile"}') {
        expect(res.score).toBe(2);
        expect(res.failClass).toBe("compile");
      }
    })
  );

  it(
    "empty command and non-zero exits are reported, never thrown",
    fuzzCases({ seed: 0xe02, runs: 30 }, async (rng) => {
      const empty = await new CommandEvaluator({ command: [], timeoutMs: 1000 }).evaluate(dir);
      expect(empty.score).toBeNull();
      expect(empty.valid).toBe(false);
      const code = rng.int(1, 5);
      const res = await new CommandEvaluator({
        command: ["bash", "-c", `exit ${code}`],
        timeoutMs: 5000
      }).evaluate(dir);
      expect(res.failClass).toBe("runtime");
      expect(res.score).toBeNull();
    })
  );

  it(
    "a timeout kills the process group and reports failClass=timeout",
    { timeout: 120_000 },
    fuzzCases({ seed: 0xe03, runs: 3, maxRuns: 3 }, async () => {
      const ev = new CommandEvaluator({ command: ["bash", "-c", "sleep 5"], timeoutMs: 150 });
      const start = Date.now();
      const res = await ev.evaluate(dir);
      expect(res.failClass).toBe("timeout");
      expect(Date.now() - start).toBeLessThan(4000);
    })
  );
});

describe("fuzz: verification hooks", () => {
  it(
    "hook exit codes map to ok, output is capped, and abort is honoured",
    fuzzCases({ seed: 0xe04, runs: 25, maxRuns: 25 }, async (rng) => {
      const code = rng.int(0, 1);
      const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 64 });
      hooks.register({ name: "h", command: `bash -c 'printf "%s" "${"x".repeat(rng.int(0, 200))}"; exit ${code}'` });
      const [res] = await hooks.runAll();
      expect(res!.name).toBe("h");
      expect(res!.ok).toBe(code === 0);
      expect(Buffer.byteLength(res!.output)).toBeLessThanOrEqual(64 + 32);
      const controller = new AbortController();
      controller.abort();
      const aborted = await hooks.runAll(controller.signal);
      expect(aborted).toEqual([]);
    })
  );

  it("verifyCommandsToHooks trims and names entries", () => {
    const hooks = verifyCommandsToHooks(["  a  ", "", "b"]);
    expect(hooks.map((h) => h.name)).toEqual(["verify-1", "verify-2"]);
    expect(hooks[0]!.command).toBe("a");
    expect(hooks[0]!.timeoutMs).toBe(120_000);
  });
});

describe("fuzz: atomic file writes", () => {
  it(
    "writeFileAtomic always leaves complete contents and preserves mode",
    fuzzCases({ seed: 0xe05, runs: 40 }, async (rng) => {
      const path = join(dir, "f.txt");
      const first = rng.str(200);
      await writeFileAtomic(path, first);
      expect(await readFile(path, "utf8")).toBe(first);
      const second = rng.str(200);
      await writeFileAtomic(path, second);
      expect(await readFile(path, "utf8")).toBe(second);
      const leftovers = (await import("node:fs/promises")).readdir(dir);
      expect((await leftovers).some((f) => f.endsWith(".tmp"))).toBe(false);
      if (rng.bool(0.3)) {
        await writeFile(path, "#!/bin/sh\n", { mode: 0o755 });
        const modeBefore = (await stat(path)).mode & 0o777;
        await writeFileAtomic(path, "#!/bin/sh\necho hi\n");
        const s = await stat(path);
        // 0o755 === 493. `writeFile(..., { mode })` is only applied at creation
        // and umask can strip bits, so assert the writer preserved whatever
        // mode the destination actually had at rewrite time.
        expect(s.mode & 0o777).toBe(modeBefore);
      }
    })
  );

  it(
    "appendLineSafe recovers from a torn trailing line",
    fuzzCases({ seed: 0xe06, runs: 40 }, async (rng) => {
      const path = join(dir, "log.jsonl");
      const lines = Array.from({ length: rng.int(0, 5) }, () => JSON.stringify({ i: rng.int(0, 99) }));
      for (const l of lines) await appendLineSafe(path, l);
      if (rng.bool()) await writeFile(path, (await readFile(path, "utf8")) + "{torn");
      await appendLineSafe(path, JSON.stringify({ i: "tail" }));
      const raw = await readFile(path, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      const parsed = raw.split("\n").filter(Boolean).map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return null;
        }
      });
      expect(parsed.at(-1)).toEqual({ i: "tail" });
      expect(parsed.filter((p) => p !== null).length).toBeGreaterThanOrEqual(lines.length);
    })
  );
});

describe("fuzz: MCP config loading", () => {
  it(
    "arbitrary mcp.json never throws and skips disabled/_ entries",
    fuzzCases({ seed: 0xe07, runs: 40 }, async (rng) => {
      const root = join(dir, `ws${rng.int(0, 1_000_000)}`);
      await mkdir(join(root, ".dream"), { recursive: true });
      const value = rng.pick([
        "{}",
        '{"mcpServers":{"a":{"command":"node"}}}',
        '{"mcpServers":{"_ex":{"command":"npx"},"b":{"command":"x","enabled":false}}}',
        '{"mcpServers":{"c":{"args":["1"]}}}',
        "not json",
        '{"mcpServers":{"d":{"command":"node","args":"not-array"}}}'
      ]);
      await writeFile(join(root, ".dream/mcp.json"), value);
      const servers = await loadMcpConfig(root);
      expect(Array.isArray(servers)).toBe(true);
      for (const s of servers) {
        expect(s.name.startsWith("_")).toBe(false);
        expect(typeof s.command).toBe("string");
        expect(Array.isArray(s.args)).toBe(true);
      }
    })
  );
});

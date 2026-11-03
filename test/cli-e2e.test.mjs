#!/usr/bin/env node


import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "cli.js");
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function run(args, opts = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd ?? root,
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 180_000,
    env: { ...process.env, DREAM_LOG_LEVEL: "warn", ...(opts.env ?? {}) }
  });
}

if (!existsSync(cli)) {
  console.error(`missing ${cli}; run \`pnpm build\` first`);
  process.exit(2);
}

check("--help lists every command", () => {
  const res = run(["--help"]);
  if (res.status !== 0) throw new Error(`exit ${res.status}: ${res.stderr}`);
  for (const cmd of ["dream", "fixed", "chat", "report", "sessions", "session", "compact"]) {
    if (!res.stdout.includes(cmd)) throw new Error(`help is missing ${cmd}`);
  }
});

check("invalid numeric flag fails fast with exit 2", () => {
  const res = run(["dream", "--rounds", "abc"]);
  if (res.status !== 2) throw new Error(`expected exit 2, got ${res.status}`);
  if (!/invalid --rounds/.test(res.stderr)) throw new Error(`unexpected stderr: ${res.stderr}`);
});

check("invalid evaluator quoting fails fast with exit 2", () => {
  const res = run(["dream", "--evaluator", 'python3 "unterminated']);
  if (res.status !== 2) throw new Error(`expected exit 2, got ${res.status}`);
  if (!/invalid --evaluator/.test(res.stderr)) throw new Error(`unexpected stderr: ${res.stderr}`);
});

const dir = mkdtempSync(join(tmpdir(), "dh-cli-e2e-"));
try {
  const runsDir = join(dir, "runs");
  const repoDir = join(dir, "repo");
  const toy = join(root, "examples", "toy-task");

  check("a fixed run produces state and a resumable report", () => {
    const res = run([
      "fixed",
      "--run-id", "e2e",
      "--rounds", "1",
      "--workers", "2",
      "--round-limit", "2",
      "--revisions", "0",
      "--beta-grid", "off",
      "--agent", "scripted",
      "--evaluator", `python3 ${JSON.stringify(join(toy, "evaluator", "evaluate.py"))} {workspace}`,
      "--init-dir", join(toy, "init"),
      "--repo", repoDir,
      "--runs-dir", runsDir
    ]);
    if (res.status !== 0) throw new Error(`exit ${res.status}\n${res.stderr}\n${res.stdout}`);
    const runDir = join(runsDir, "e2e");
    if (!existsSync(join(runDir, "state.json"))) throw new Error("state.json was not written");
    const trees = readdirSync(join(runDir, "trees"));
    if (trees.length < 1) throw new Error("no tree was recorded");
  });

  check("report --json lists the run", () => {
    const res = run(["report", "--json", "--runs-dir", runsDir]);
    if (res.status !== 0) throw new Error(`exit ${res.status}: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    if (!Array.isArray(parsed) || !parsed.some((r) => r.runId === "e2e")) {
      throw new Error(`run missing from report: ${res.stdout.slice(0, 300)}`);
    }
  });

  check("re-running the same run id resumes at the round boundary", () => {
    const res = run([
      "fixed",
      "--run-id", "e2e",
      "--rounds", "1",
      "--workers", "2",
      "--round-limit", "2",
      "--revisions", "0",
      "--beta-grid", "off",
      "--evaluator", `python3 ${JSON.stringify(join(toy, "evaluator", "evaluate.py"))} {workspace}`,
      "--init-dir", join(toy, "init"),
      "--repo", repoDir,
      "--runs-dir", runsDir
    ]);
    if (res.status !== 0) throw new Error(`exit ${res.status}\n${res.stderr}`);

    const before = readFileSync(join(runsDir, "e2e", "state.json"), "utf8");
    if (!/"round": 1/.test(before)) throw new Error(`unexpected state: ${before.slice(0, 200)}`);
  });

  check("JSON logs are one object per line on stderr", () => {
    const res = run(
      ["fixed", "--run-id", "jsonlog", "--rounds", "1", "--workers", "1", "--round-limit", "1",
       "--revisions", "0", "--beta-grid", "off",
       "--evaluator", `python3 ${JSON.stringify(join(toy, "evaluator", "evaluate.py"))} {workspace}`,
       "--init-dir", join(toy, "init"), "--repo", join(dir, "repo2"), "--runs-dir", join(dir, "runs2"),
       "--log-format", "json", "--log-level", "info"],
      { env: { DREAM_LOG_LEVEL: "info", DREAM_LOG_FORMAT: "text" } }
    );
    if (res.status !== 0) throw new Error(`exit ${res.status}\n${res.stderr}`);
    const lines = res.stderr.split("\n").filter((l) => l.trim().startsWith("{"));
    if (lines.length === 0) throw new Error("no JSON log lines on stderr");
    for (const line of lines) {
      const rec = JSON.parse(line);
      if (typeof rec.level !== "string" || typeof rec.scope !== "string") {
        throw new Error(`malformed log record: ${line}`);
      }
    }
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} CLI end-to-end check(s) failed`);
  process.exit(1);
}
console.log("\nall CLI end-to-end checks passed");

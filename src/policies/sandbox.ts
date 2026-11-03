import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { collectText } from "../util/stream.js";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { DiscoveryTree, ReplayReport, ReplayScoreConfig, TreeSummary } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the project root without depending on the caller's cwd.
 *
 * `src/policies/` and the bundled `dist/` both sit two levels below the
 * package root, so walk up until `package.json` is found. Previously the
 * runner was invoked through `<process.cwd()>/node_modules/.bin/tsx`, which
 * broke whenever the harness was started from another directory.
 */
function packageRoot(): string {
  let dir = here;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return here;
}

/**
 * Locate `sandboxRunner.ts`.
 *
 * Source runs find it next to this module (`src/policies/sandboxRunner.ts`).
 * The bundled `dist/cli.js` has no TypeScript siblings, so fall back to the
 * package root's `src/policies/sandboxRunner.ts`. Without this the child
 * process fails with ERR_MODULE_NOT_FOUND and every replay silently scores
 * `-Infinity`, which selection then reads as "no policy works".
 */
function resolveRunnerPath(): string {
  const nextToHere = join(here, "sandboxRunner.ts");
  if (existsSync(nextToHere)) return nextToHere;
  const fromRoot = join(packageRoot(), "src", "policies", "sandboxRunner.ts");
  if (existsSync(fromRoot)) return fromRoot;
  return nextToHere;
}

const runnerPath = resolveRunnerPath();

/**
 * Resolve the TypeScript runner. Prefer a real executable from node_modules
 * (fast path), then fall back to running the tsx CLI module through Node
 * (works when the shell wrapper is missing, e.g. on some CI images).
 */
function resolveRunner(): { command: string; prefix: string[] } {
  const root = packageRoot();
  const bin = join(root, "node_modules", ".bin", "tsx");
  if (existsSync(bin)) return { command: bin, prefix: [] };
  const cli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(cli)) return { command: process.execPath, prefix: [cli] };
  // Last resort: rely on PATH. Still correct, just not cwd-dependent.
  return { command: "tsx", prefix: [] };
}

/** Environment variables a replay child is allowed to inherit. */
export const SANDBOX_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL"
] as const;

/**
 * Environment handed to a replay child. The policy is untrusted code, so we
 * do not forward API keys or other secrets from the parent process; only the
 * variables needed to run Node are kept.
 *
 * `NODE_OPTIONS` is deliberately absent: it can inject `--require`/`--import`
 * preloads (arbitrary code in the child), `--inspect` (an open debugger port),
 * or disable the module policy. Anything that is not an allowlisted key, and
 * every `NODE_*` key, is dropped.
 */
export function sandboxEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Node flags passed before the runner script. They remove the most dangerous
 * in-process escape hatches a policy could reach for without needing an OS
 * sandbox: tampering with built-in prototypes, prototype-pollution writes,
 * and loading native addons.
 */
export const SANDBOX_NODE_FLAGS = [
  "--frozen-intrinsics",
  "--disable-proto=throw",
  "--no-addons"
] as const;

export interface SandboxConfig {
  timeoutMs: number;
  memoryMb: number;
  scoreConfig: ReplayScoreConfig;
  /** Policy beta knob passed to the constructor; defaults to the policy's own. */
  beta?: number;
  /** Effective grid plan handed to the policy constructor, when known. */
  plan?: { branchCount: number; refineCount: number };
  /** Per-tree replay round cap K2; defaults to the tree's recorded limit. */
  maxRounds?: number;
}

/**
 * Replay isolation is a **process boundary**, not a security sandbox.
 *
 * A policy bundle runs in a separate child process with:
 *   - a wall-clock timeout (the process group is SIGKILLed)
 *   - a V8 heap cap (`--max-old-space-size`)
 *   - a scrubbed environment (allowlist only; no API keys, no `NODE_OPTIONS`)
 *   - hardened Node flags (frozen intrinsics, `__proto__` writes throw, no
 *     native addons) and no inspector/`NODE_OPTIONS` preload hook
 *   - no access to the parent's live objects or event loop
 *
 * It does **not** restrict filesystem or network access. Untrusted code that
 * must be contained has to run inside a container / VM / OS sandbox; the name
 * here describes the process isolation only. `src/policies/sandbox.test.ts`
 * pins the guarantees above and the README's "Known limits" section states the
 * remaining gap explicitly.
 */

export interface SandboxResult {
  report: ReplayReport;
  failed: boolean;
  reason: string | null;
}

function execRunner(
  payload: string,
  cfg: SandboxConfig
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const runner = resolveRunner();
    const args = [
      ...runner.prefix,
      ...SANDBOX_NODE_FLAGS,
      `--max-old-space-size=${cfg.memoryMb}`,
      runnerPath
    ];
    const child = spawn(runner.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: sandboxEnv(),
      // Windows has no process groups to kill; the fallback `child.kill`
      // handles it, so do not request POSIX-only behaviour there.
      ...(process.platform === "win32" ? { windowsHide: true } : {})
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, cfg.timeoutMs);
    // StringDecoder-backed: a policy may print non-ASCII output and a chunk
    // boundary inside a multi-byte sequence must not become U+FFFD.
    const outSink = collectText(child.stdout);
    const errSink = collectText(child.stderr);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout: outSink.flush(),
        stderr: errSink.flush() + String(err),
        timedOut
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: outSink.flush(), stderr: errSink.flush(), timedOut });
    });
    child.stdin.end(payload);
  });
}

export async function runPolicyInSandbox(opts: {
  bundlePath: string;
  tree: DiscoveryTree;
  priorHistory: TreeSummary[];
  policyId: string;
  config: SandboxConfig;
}): Promise<SandboxResult> {
  const payload = JSON.stringify({
    bundlePath: opts.bundlePath,
    tree: opts.tree,
    priorHistory: opts.priorHistory,
    policyId: opts.policyId,
    scoreConfig: opts.config.scoreConfig,
    beta: opts.config.beta ?? null,
    plan: opts.config.plan ?? null,
    maxRounds: opts.config.maxRounds ?? null
  });
  const started = Date.now();
  const res = await execRunner(payload, opts.config);
  const wallMs = Date.now() - started;
  if (res.timedOut) {
    return {
      report: failedReport(
        opts.tree,
        opts.policyId,
        `sandbox timed out after ${opts.config.timeoutMs}ms`,
        wallMs
      ),
      failed: true,
      reason: "timeout"
    };
  }
  const line = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .at(-1);
  if (!line) {
    return {
      report: failedReport(
        opts.tree,
        opts.policyId,
        `sandbox produced no output (exit ${res.code}): ${res.stderr.slice(0, 500)}`,
        wallMs
      ),
      failed: true,
      reason: "crash"
    };
  }
  try {
    const parsed = JSON.parse(line) as { report: ReplayReport; negativeInfinity?: boolean };
    const report: ReplayReport = {
      ...parsed.report,
      score: parsed.negativeInfinity ? Number.NEGATIVE_INFINITY : parsed.report.score,
      wallMs
    };
    const failed = report.error !== null || !Number.isFinite(report.score);
    return {
      report,
      failed,
      reason: !failed ? null : report.illegal ? "illegal" : "error"
    };
  } catch {
    return {
      report: failedReport(opts.tree, opts.policyId, "sandbox output was not valid JSON", wallMs),
      failed: true,
      reason: "invalid-output"
    };
  }
}

function failedReport(
  tree: DiscoveryTree,
  policyId: string,
  error: string,
  wallMs: number
): ReplayReport {
  return {
    treeIndex: tree.treeIndex,
    policyId,
    score: Number.NEGATIVE_INFINITY,
    best: tree.baselineScore,
    n: 0,
    k: 0,
    maxParallelism: tree.maxParallelism,
    batches: [],
    revealed: [],
    error,
    illegal: false,
    timedOut: error.includes("timed out"),
    wallMs
  };
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { collectText } from "../util/stream.js";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { DiscoveryTree, ReplayReport, ReplayScoreConfig, TreeSummary } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));

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

function resolveRunnerPath(): string {
  const nextToHere = join(here, "sandboxRunner.ts");
  if (existsSync(nextToHere)) return nextToHere;
  const fromRoot = join(packageRoot(), "src", "policies", "sandboxRunner.ts");
  if (existsSync(fromRoot)) return fromRoot;
  return nextToHere;
}

const runnerPath = resolveRunnerPath();

function resolveRunner(): { command: string; prefix: string[] } {
  const root = packageRoot();
  const bin = join(root, "node_modules", ".bin", "tsx");
  if (existsSync(bin)) return { command: bin, prefix: [] };
  const cli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  if (existsSync(cli)) return { command: process.execPath, prefix: [cli] };

  return { command: "tsx", prefix: [] };
}

export const SANDBOX_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL"
] as const;

export function sandboxEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export const SANDBOX_NODE_FLAGS = [
  "--frozen-intrinsics",
  "--disable-proto=throw",
  "--no-addons"
] as const;

export interface SandboxConfig {
  timeoutMs: number;
  memoryMb: number;
  scoreConfig: ReplayScoreConfig;

  beta?: number;

  plan?: { branchCount: number; refineCount: number };

  maxRounds?: number;
}

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

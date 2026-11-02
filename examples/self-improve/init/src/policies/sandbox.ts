import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  DiscoveryTree,
  ReplayReport,
  ReplayScoreConfig,
  TreeSummary
} from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(here, "sandboxRunner.ts");

export interface SandboxConfig {
  timeoutMs: number;
  memoryMb: number;
  scoreConfig: ReplayScoreConfig;
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
    const args = [`--max-old-space-size=${cfg.memoryMb}`, runnerPath];
    const tsxBin = join(process.cwd(), "node_modules", ".bin", "tsx");
    const child = spawn(tsxBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, cfg.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
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
    scoreConfig: opts.config.scoreConfig
  });
  const started = Date.now();
  const res = await execRunner(payload, opts.config);
  const wallMs = Date.now() - started;
  if (res.timedOut) {
    return {
      report: failedReport(opts.tree, opts.policyId, `sandbox timed out after ${opts.config.timeoutMs}ms`, wallMs),
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
    batches: [],
    revealed: [],
    error,
    illegal: false,
    timedOut: error.includes("timed out"),
    wallMs
  };
}

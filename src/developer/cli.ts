import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PolicyDeveloper, ReplayReport } from "../types.js";
import { renderFeedbackMarkdown } from "./report.js";
import { runCli } from "../agents/cli.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the default developer prompt.
 *
 * Source runs find it at `<repo>/prompts/policy-developer.md`. The bundled
 * `dist/cli.js` sits one level below the package root, so resolve the package
 * root and read `<root>/prompts/policy-developer.md`.
 */
function defaultPromptPath(): string {
  const direct = join(here, "..", "..", "prompts", "policy-developer.md");
  if (existsSync(direct)) return direct;
  let dir = here;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json"))) {
      const candidate = join(dir, "prompts", "policy-developer.md");
      if (existsSync(candidate)) return candidate;
      break;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return direct;
}

export interface CliPolicyDeveloperConfig {
  command: string[];
  promptPath?: string;
  promptMode?: "stdin" | "arg";
  timeoutMs?: number;
  workDir: string;
  env?: Record<string, string>;
}

export class CliPolicyDeveloper implements PolicyDeveloper {
  private readonly cfg: Required<Omit<CliPolicyDeveloperConfig, "env" | "promptPath">> & {
    env?: Record<string, string>;
    promptPath: string;
  };
  private calls = 0;

  constructor(cfg: CliPolicyDeveloperConfig) {
    this.cfg = {
      command: cfg.command,
      promptPath: resolve(cfg.promptPath ?? defaultPromptPath()),
      promptMode: cfg.promptMode ?? "stdin",
      timeoutMs: cfg.timeoutMs ?? 900000,
      workDir: cfg.workDir,
      env: cfg.env
    };
  }

  async revise(input: {
    currentPolicySource: string;
    replayReports: ReplayReport[];
    previousFeedback: string[];
    trees?: import("../types.js").DiscoveryTree[];
    scoreConfig?: import("../types.js").ReplayScoreConfig;
  }): Promise<string> {
    this.calls += 1;
    const dir = join(this.cfg.workDir, `rev-${this.calls}`);
    await mkdir(dir, { recursive: true });
    const policyPath = join(dir, "policy.ts");
    const notesPath = join(dir, "feedback.md");
    await writeFile(policyPath, input.currentPolicySource, "utf8");

    // Use the real replay worlds and the objective selection used, so the
    // developer sees true baselines, deltas, penalties and bonuses. Only fall
    // back to synthesized trees when a caller does not supply them.
    const trees = input.trees ?? summarizeReportsForFeedback(input.replayReports);
    const scoreConfig = input.scoreConfig ?? {
      beta1: 0.002,
      beta2: 0.01,
      normalize: "none" as const
    };
    const report = renderFeedbackMarkdown("current", input.replayReports, trees, scoreConfig);
    await writeFile(notesPath, `${report}\n\n${input.previousFeedback.join("\n\n")}\n`, "utf8");

    const instructions = await readFile(this.cfg.promptPath, "utf8");
    const prompt = [
      instructions,
      "",
      `The policy file to edit is: ${policyPath}`,
      `Replay feedback: ${notesPath}`,
      "",
      "Edit only that policy file. When finished, reply with a one-paragraph summary of the rules you implemented."
    ].join("\n");

    const res = await runCli({
      command: this.cfg.command,
      cwd: dir,
      prompt,
      promptMode: this.cfg.promptMode,
      timeoutMs: this.cfg.timeoutMs,
      env: this.cfg.env
    });
    if (res.timedOut) throw new Error(`policy developer timed out after ${this.cfg.timeoutMs}ms`);
    if (res.code !== 0) {
      throw new Error(`policy developer exited ${res.code}: ${res.stderr.slice(0, 2000)}`);
    }
    return readFile(policyPath, "utf8");
  }
}

/**
 * Fallback only: reconstruct minimal worlds when the caller does not hand over
 * the real trees. `report.best` is a normalized best score, never the tree's
 * baseline, so this cannot recover the true baseline. Callers that have the
 * trees (`runOfflinePhase`) must pass them.
 */
function summarizeReportsForFeedback(
  reports: ReplayReport[]
): import("../types.js").DiscoveryTree[] {
  return reports.map((report) => ({
    runId: "feedback",
    treeIndex: report.treeIndex,
    baselineScore: 0,
    maxParallelism: report.maxParallelism,
    roundsLimit: report.k,
    policyId: report.policyId,
    nodes: [],
    createdAt: new Date(0).toISOString()
  }));
}

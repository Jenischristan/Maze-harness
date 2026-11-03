import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DiscoveryTree,
  PolicyDeveloper,
  PolicyVersionRecord,
  ReplayReport,
  ReplayScoreConfig,
  TreeSummary
} from "../types.js";
import { compilePolicy } from "../policies/loader.js";
import { runPolicyInSandbox } from "../policies/sandbox.js";
import {
  BETA_SWEEP_GRID,
  betaSweepFromCells,
  meanScoreOverGrid,
  scoreBetaCell,
  type BetaSweepResult
} from "../score.js";
import { buildFeedbackReport } from "../developer/report.js";
import type { RunStore } from "../runs/store.js";

export interface OfflineConfig {
  round: number;
  currentPolicyId: string;
  currentPolicySource: string;
  trees: DiscoveryTree[];
  histories: Map<number, TreeSummary[]>;
  developer: PolicyDeveloper;
  store: RunStore;
  revisions: number;
  scoreConfig: ReplayScoreConfig;
  sandbox: { timeoutMs: number; memoryMb: number };
  policyWorkDir: string;
  useTrees?: DiscoveryTree[];
  /** rho grid for selection; defaults to DREAM-RSI's RHO_GRID. */
  scoreGrid?: readonly number[];
  /**
   * Beta grid for the paper's evaluation-time sweep. `null` disables the
   * sweep and selects on the rho-grid mean alone.
   */
  betaGrid?: readonly number[] | null;
  /** Lambda in `pareto.reward = auc - lambda * parallel_penalty`. */
  paretoLambda?: number;
  /** Effective grid plan for this round, handed to replayed policies. */
  plan?: { branchCount: number; refineCount: number };
  onEvent?: (event: OfflineEvent) => void;
}

export interface OfflineEvent {
  type: "policy-evaluated" | "revision-started" | "revision-finished" | "selected";
  round: number;
  policyId: string;
  meanScore?: number;
  error?: string;
}

export interface OfflineResult {
  records: PolicyVersionRecord[];
  selected: PolicyVersionRecord;
  reportsByPolicy: Map<string, ReplayReport[]>;
  /** Per-policy beta sweeps, for `beta_sweep.json` and developer feedback. */
  sweepsByPolicy: Map<string, BetaSweepResult>;
}

/**
 * Evaluate one policy at every beta in the sweep and rank the resulting
 * attainment/work/parallelism curve by `pareto.reward` (paper Appendix B.2).
 * Each beta is a fresh sandbox replay set, so a policy that ignores `beta`
 * produces a degenerate (flat) curve.
 */
async function evaluateBetaSweep(opts: {
  policyId: string;
  bundlePath: string;
  trees: DiscoveryTree[];
  histories: Map<number, TreeSummary[]>;
  scoreConfig: ReplayScoreConfig;
  sandbox: { timeoutMs: number; memoryMb: number };
  grid: readonly number[];
  lambda: number;
  plan?: { branchCount: number; refineCount: number };
}): Promise<{ sweep: BetaSweepResult; bestBeta: number | null; reportsAtBest: ReplayReport[] }> {
  const baselineOf = (treeIndex: number): number =>
    opts.trees.find((t) => t.treeIndex === treeIndex)?.baselineScore ?? 0;
  const cells: Array<{
    beta: number;
    attainment: number;
    probes: number;
    rounds: number;
    parallelPenalty: number;
  }> = [];
  const reportsByBeta = new Map<number, ReplayReport[]>();
  for (const beta of opts.grid) {
    const reports: ReplayReport[] = [];
    for (const tree of opts.trees) {
      const res = await runPolicyInSandbox({
        bundlePath: opts.bundlePath,
        tree,
        priorHistory: opts.histories.get(tree.treeIndex) ?? [],
        policyId: opts.policyId,
        config: {
          timeoutMs: opts.sandbox.timeoutMs,
          memoryMb: opts.sandbox.memoryMb,
          scoreConfig: opts.scoreConfig,
          plan: opts.plan,
          beta
        }
      });
      reports.push(res.report);
    }
    reportsByBeta.set(beta, reports);
    cells.push(scoreBetaCell(beta, reports, baselineOf));
  }
  const sweep = betaSweepFromCells(cells, opts.lambda);
  // The baked-in default is the beta whose cell carries the most reward;
  // ties keep the current policy's own default (the caller decides).
  let bestBeta: number | null = null;
  let bestReward = -Infinity;
  for (const cell of sweep.cells) {
    if (cell.reward > bestReward) {
      bestReward = cell.reward;
      bestBeta = cell.beta;
    }
  }
  return {
    sweep,
    bestBeta,
    reportsAtBest: bestBeta === null ? [] : (reportsByBeta.get(bestBeta) ?? [])
  };
}

/** Mean V under every budget preference rho, computed from the tree baselines. */
function gridMean(
  reports: ReplayReport[],
  trees: DiscoveryTree[],
  config: ReplayScoreConfig,
  grid?: readonly number[]
): number {
  const baselineOf = (treeIndex: number): number =>
    trees.find((t) => t.treeIndex === treeIndex)?.baselineScore ?? 0;
  return meanScoreOverGrid(reports, config, baselineOf, grid);
}

export async function evaluatePolicyOnTrees(opts: {
  policyId: string;
  bundlePath: string;
  trees: DiscoveryTree[];
  histories: Map<number, TreeSummary[]>;
  scoreConfig: ReplayScoreConfig;
  sandbox: { timeoutMs: number; memoryMb: number };
  /** Effective grid plan for this round, handed to the policy constructor. */
  plan?: { branchCount: number; refineCount: number };
}): Promise<ReplayReport[]> {
  const reports: ReplayReport[] = [];
  for (const tree of opts.trees) {
    const res = await runPolicyInSandbox({
      bundlePath: opts.bundlePath,
      tree,
      priorHistory: opts.histories.get(tree.treeIndex) ?? [],
      policyId: opts.policyId,
      config: {
        timeoutMs: opts.sandbox.timeoutMs,
        memoryMb: opts.sandbox.memoryMb,
        scoreConfig: opts.scoreConfig,
        plan: opts.plan
      }
    });
    reports.push(res.report);
  }
  return reports;
}

export async function runOfflinePhase(cfg: OfflineConfig): Promise<OfflineResult> {
  await mkdir(cfg.policyWorkDir, { recursive: true });
  const evalTrees = cfg.useTrees ?? cfg.trees;
  const records: PolicyVersionRecord[] = [];
  const reportsByPolicy = new Map<string, ReplayReport[]>();
  const sweepsByPolicy = new Map<string, BetaSweepResult>();
  const feedbackLog: string[] = [];
  const betaGrid = cfg.betaGrid === undefined ? BETA_SWEEP_GRID : cfg.betaGrid;
  const paretoLambda = cfg.paretoLambda ?? 0;

  const current = await evaluateVersion({
    round: cfg.round,
    policyId: cfg.currentPolicyId,
    source: cfg.currentPolicySource,
    isCurrent: true
  });
  if (!current) throw new Error("failed to compile current policy");
  records.push(current.record);
  reportsByPolicy.set(current.record.policyId, current.reports);
  if (current.sweep) sweepsByPolicy.set(current.record.policyId, current.sweep);
  feedbackLog.push(
    renderFeedback(
      current.record.policyId,
      current.reports,
      cfg,
      evalTrees,
      current.sweep ?? undefined
    )
  );
  cfg.onEvent?.({
    type: "policy-evaluated",
    round: cfg.round,
    policyId: current.record.policyId,
    meanScore: current.record.meanScore
  });

  let previous = current;
  for (let m = 0; m < cfg.revisions; m += 1) {
    cfg.onEvent?.({
      type: "revision-started",
      round: cfg.round,
      policyId: previous.record.policyId
    });
    const policyId = `t${cfg.round}-m${m + 1}`;
    let source: string;
    try {
      source = await cfg.developer.revise({
        currentPolicySource: previous.record.source,
        replayReports: previous.reports,
        previousFeedback: feedbackLog,
        // The developer must see the same baseline and objective selection used.
        trees: evalTrees,
        scoreConfig: cfg.scoreConfig
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      feedbackLog.push(`revision ${policyId} failed: ${message}`);
      cfg.onEvent?.({
        type: "revision-finished",
        round: cfg.round,
        policyId,
        error: message
      });
      continue;
    }
    const compiled = await compilePolicy({
      source,
      outDir: join(cfg.store.dir, "policies", "build"),
      policyId
    });
    if (!compiled.ok || !compiled.bundlePath) {
      feedbackLog.push(`revision ${policyId} did not compile: ${compiled.error}`);
      cfg.onEvent?.({
        type: "revision-finished",
        round: cfg.round,
        policyId,
        error: compiled.error ?? "compile failed"
      });
      continue;
    }
    const reports = await evaluatePolicyOnTrees({
      policyId,
      bundlePath: compiled.bundlePath,
      trees: evalTrees,
      histories: cfg.histories,
      scoreConfig: cfg.scoreConfig,
      sandbox: cfg.sandbox,
      plan: cfg.plan
    });
    const sweepRes = betaGrid
      ? await evaluateBetaSweep({
          policyId,
          bundlePath: compiled.bundlePath,
          trees: evalTrees,
          histories: cfg.histories,
          scoreConfig: cfg.scoreConfig,
          sandbox: cfg.sandbox,
          plan: cfg.plan,
          grid: betaGrid,
          lambda: paretoLambda
        })
      : null;
    const record: PolicyVersionRecord = {
      policyId,
      source,
      meanScore: sweepRes
        ? sweepRes.sweep.reward
        : gridMean(reports, evalTrees, cfg.scoreConfig, cfg.scoreGrid),
      scores: reports.map((r) => r.score),
      selected: false,
      createdAt: new Date().toISOString()
    };
    records.push(record);
    reportsByPolicy.set(policyId, reports);
    if (sweepRes) sweepsByPolicy.set(policyId, sweepRes.sweep);
    feedbackLog.push(renderFeedback(policyId, reports, cfg, evalTrees, sweepRes?.sweep));
    previous = { record, reports, sweep: sweepRes ? sweepRes.sweep : null };
    cfg.onEvent?.({
      type: "revision-finished",
      round: cfg.round,
      policyId,
      meanScore: record.meanScore
    });
  }

  let selected = records[0] as PolicyVersionRecord;
  for (const record of records.slice(1)) {
    if (record.meanScore > selected.meanScore) selected = record;
  }
  for (const record of records) {
    record.selected = record.policyId === selected.policyId;
    await cfg.store.savePolicyVersion(cfg.round, record);
  }
  for (const [policyId, reports] of reportsByPolicy) {
    await cfg.store.saveReplayReports(cfg.round, policyId, reports);
  }
  for (const [policyId, sweep] of sweepsByPolicy) {
    await writeFile(
      join(
        cfg.store.dir,
        "reports",
        `t${String(cfg.round).padStart(4, "0")}-${policyId}-beta_sweep.json`
      ),
      `${JSON.stringify(sweep, null, 2)}\n`,
      "utf8"
    );
  }
  await writeFile(
    join(cfg.store.dir, "reports", `t${String(cfg.round).padStart(4, "0")}-feedback.md`),
    feedbackLog.join("\n\n"),
    "utf8"
  );
  cfg.onEvent?.({
    type: "selected",
    round: cfg.round,
    policyId: selected.policyId,
    meanScore: selected.meanScore
  });
  return { records, selected, reportsByPolicy, sweepsByPolicy };

  async function evaluateVersion(input: {
    round: number;
    policyId: string;
    source: string;
    isCurrent: boolean;
  }): Promise<{
    record: PolicyVersionRecord;
    reports: ReplayReport[];
    sweep: BetaSweepResult | null;
  } | null> {
    const compiled = await compilePolicy({
      source: input.source,
      outDir: join(cfg.store.dir, "policies", "build"),
      policyId: input.policyId
    });
    if (!compiled.ok || !compiled.bundlePath) {
      cfg.onEvent?.({
        type: "policy-evaluated",
        round: input.round,
        policyId: input.policyId,
        error: compiled.error ?? "compile failed"
      });
      return null;
    }
    const reports = await evaluatePolicyOnTrees({
      policyId: input.policyId,
      bundlePath: compiled.bundlePath,
      trees: evalTrees,
      histories: cfg.histories,
      scoreConfig: cfg.scoreConfig,
      sandbox: cfg.sandbox,
      plan: cfg.plan
    });
    const sweepRes = betaGrid
      ? await evaluateBetaSweep({
          policyId: input.policyId,
          bundlePath: compiled.bundlePath,
          trees: evalTrees,
          histories: cfg.histories,
          scoreConfig: cfg.scoreConfig,
          sandbox: cfg.sandbox,
          plan: cfg.plan,
          grid: betaGrid,
          lambda: paretoLambda
        })
      : null;
    return {
      record: {
        policyId: input.policyId,
        source: input.source,
        meanScore: sweepRes
          ? sweepRes.sweep.reward
          : gridMean(reports, evalTrees, cfg.scoreConfig, cfg.scoreGrid),
        scores: reports.map((r) => r.score),
        selected: false,
        createdAt: new Date().toISOString()
      },
      reports,
      sweep: sweepRes ? sweepRes.sweep : null
    };
  }
}

function renderFeedback(
  policyId: string,
  reports: ReplayReport[],
  cfg: OfflineConfig,
  trees: DiscoveryTree[],
  sweep?: BetaSweepResult
): string {
  const lines = [
    `## ${policyId} mean=${gridMean(reports, trees, cfg.scoreConfig, cfg.scoreGrid).toFixed(4)}`
  ];
  if (sweep) {
    lines.push(
      `beta sweep: pareto.reward=${sweep.reward.toFixed(4)} auc=${sweep.auc.toFixed(4)} parallel_penalty=${sweep.parallelPenalty.toFixed(4)}${sweep.degenerate ? " (DEGENERATE: beta does not change the trade-off)" : ""}`
    );
    lines.push(
      `  cells: ${sweep.cells
        .map(
          (c) =>
            `beta=${c.beta} attainment=${c.attainment.toFixed(4)} probes=${c.probes} penalty=${c.parallelPenalty.toFixed(3)}`
        )
        .join(" | ")}`
    );
  }
  for (const report of reports) {
    const tree = trees.find((t) => t.treeIndex === report.treeIndex);
    if (!tree) continue;
    const fb = buildFeedbackReport(tree, report, cfg.scoreConfig);
    lines.push(
      `tree ${fb.treeIndex}: V=${fb.score.toFixed(4)} best=${fb.components.best.toFixed(4)} N=${fb.components.n} k=${fb.components.k}${fb.error ? ` ERROR=${fb.error}` : ""}`
    );
  }
  return lines.join("\n");
}

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
import { meanScoreOverGrid } from "../score.js";
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
}

/** Mean V under every budget preference rho, computed from the tree baselines. */
function gridMean(
  reports: ReplayReport[],
  trees: DiscoveryTree[],
  config: ReplayScoreConfig
): number {
  const baselineOf = (treeIndex: number): number =>
    trees.find((t) => t.treeIndex === treeIndex)?.baselineScore ?? 0;
  return meanScoreOverGrid(reports, config, baselineOf);
}

export async function evaluatePolicyOnTrees(opts: {
  policyId: string;
  bundlePath: string;
  trees: DiscoveryTree[];
  histories: Map<number, TreeSummary[]>;
  scoreConfig: ReplayScoreConfig;
  sandbox: { timeoutMs: number; memoryMb: number };
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
        scoreConfig: opts.scoreConfig
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
  const feedbackLog: string[] = [];

  const current = await evaluateVersion({
    round: cfg.round,
    policyId: cfg.currentPolicyId,
    source: cfg.currentPolicySource,
    isCurrent: true
  });
  if (!current) throw new Error("failed to compile current policy");
  records.push(current.record);
  reportsByPolicy.set(current.record.policyId, current.reports);
  feedbackLog.push(renderFeedback(current.record.policyId, current.reports, cfg, evalTrees));
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
        previousFeedback: feedbackLog
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
      sandbox: cfg.sandbox
    });
    const record: PolicyVersionRecord = {
      policyId,
      source,
      meanScore: gridMean(reports, evalTrees, cfg.scoreConfig),
      scores: reports.map((r) => r.score),
      selected: false,
      createdAt: new Date().toISOString()
    };
    records.push(record);
    reportsByPolicy.set(policyId, reports);
    feedbackLog.push(renderFeedback(policyId, reports, cfg, evalTrees));
    previous = { record, reports };
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
  return { records, selected, reportsByPolicy };

  async function evaluateVersion(input: {
    round: number;
    policyId: string;
    source: string;
    isCurrent: boolean;
  }): Promise<{ record: PolicyVersionRecord; reports: ReplayReport[] } | null> {
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
      sandbox: cfg.sandbox
    });
    return {
      record: {
        policyId: input.policyId,
        source: input.source,
        meanScore: gridMean(reports, evalTrees, cfg.scoreConfig),
        scores: reports.map((r) => r.score),
        selected: false,
        createdAt: new Date().toISOString()
      },
      reports
    };
  }
}

function renderFeedback(
  policyId: string,
  reports: ReplayReport[],
  cfg: OfflineConfig,
  trees: DiscoveryTree[]
): string {
  const lines = [`## ${policyId} mean=${gridMean(reports, trees, cfg.scoreConfig).toFixed(4)}`];
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

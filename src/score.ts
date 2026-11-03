import type { DiscoveryTree, ReplayReport, ReplayScoreConfig } from "./types.js";
import type { ReplayEnv } from "./env/replay.js";

export const DEFAULT_SCORE_CONFIG: ReplayScoreConfig = {
  beta1: 0.002,
  beta2: 0.01,
  normalize: "relativeToBaseline"
};

export const RHO_GRID = [0, 0.25, 0.5, 0.75, 1] as const;

export const BUDGET_GAMMA = 0.01;

export interface ScoreInput {
  baselineScore: number;
  revealedScores: Array<number | null>;
  rounds: number;
  config: ReplayScoreConfig;

  batchSizes?: number[];
}

export interface ScoreComponents {
  best: number;
  n: number;
  k: number;
  penalty: number;
  bonus: number;
  score: number;
}

function normalizeScore(s: number, baseline: number, mode: ReplayScoreConfig["normalize"]): number {
  if (mode === "none") return s;
  const denom = Math.max(Math.abs(baseline), 1);
  return (s - baseline) / denom;
}

export function computeScore(input: ScoreInput): ScoreComponents {
  const { baselineScore, revealedScores, rounds, config } = input;
  const n = revealedScores.length;
  let best: number | null = null;
  for (const s of revealedScores) {
    if (s === null) continue;
    if (best === null || s > best) best = s;
  }
  const bestRaw = best ?? baselineScore;
  const bestNorm = normalizeScore(bestRaw, baselineScore, config.normalize);
  const k = Math.max(1, rounds);
  const explored = n > 0;

  const beta1 = config.beta1 ?? 0;
  const beta2 = config.beta2 ?? 0;
  const lambda = config.lambda ?? 0;

  const width = input.batchSizes ? input.batchSizes.reduce((a, s) => a + Math.max(0, s - 1), 0) : 0;

  const rho = config.rho === undefined ? null : clamp01(config.rho);
  const gamma = rho === null ? 0 : BUDGET_GAMMA;

  const penalty = beta1 * n + lambda * width;
  const bonus = explored ? (beta2 * n) / k : 0;

  const speedTerm = rho === null || !explored ? 0 : (rho * gamma * n) / k;
  const spendTerm = rho === null || !explored ? 0 : (1 - rho) * gamma * n;
  return {
    best: bestNorm,
    n,
    k: rounds,
    penalty,
    bonus,
    score: bestNorm - penalty + bonus - speedTerm + spendTerm
  };
}

export function scoreReplay(
  tree: DiscoveryTree,
  env: ReplayEnv,
  policyId: string,
  config: ReplayScoreConfig,
  error: string | null = null,
  illegal = false,
  timedOut = false,
  wallMs = 0
): ReplayReport {
  const revealed = env.revealedObservations();
  const comp = computeScore({
    baselineScore: tree.baselineScore,
    revealedScores: revealed.map((o) => o.score),
    rounds: env.rounds,
    batchSizes: env.batchesTaken().map((b) => b.length),
    config
  });
  return {
    treeIndex: tree.treeIndex,
    policyId,
    score: error ? Number.NEGATIVE_INFINITY : comp.score,
    best: comp.best,
    n: comp.n,
    k: comp.k,
    maxParallelism: env.maxParallelism,
    batches: env.batchesTaken(),
    revealed,
    error,
    illegal,
    timedOut,
    wallMs
  };
}

export function meanScoreOverGrid(
  reports: ReadonlyArray<ReplayReport>,
  config: ReplayScoreConfig,
  baselineOf: (treeIndex: number) => number,
  grid: readonly number[] = RHO_GRID
): number {
  if (reports.length === 0) return 0;
  const cells = grid.length > 0 ? grid : [0];
  let total = 0;
  for (const report of reports) {
    if (!Number.isFinite(report.score)) {
      total += Number.NEGATIVE_INFINITY;
      continue;
    }
    const revealedScores = report.revealed.map((o) => o.score);
    const batchSizes = report.batches.map((b) => b.length);
    let perTree = 0;
    for (const rho of cells) {
      const comp = computeScore({
        baselineScore: baselineOf(report.treeIndex),
        revealedScores,
        rounds: report.k,
        batchSizes,
        config: { ...config, rho }
      });
      perTree += comp.score;
    }
    total += perTree / cells.length;
  }
  return total / reports.length;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function meanScore(reports: ReadonlyArray<ReplayReport>): number {
  if (reports.length === 0) return 0;
  let sum = 0;
  for (const r of reports) sum += r.score;
  return sum / reports.length;
}

function scoreReport(
  report: ReplayReport,
  config: ReplayScoreConfig,
  baseline: number
): ScoreComponents {
  const comp = computeScore({
    baselineScore: baseline,
    revealedScores: report.revealed.map((o) => o.score),
    rounds: report.k,
    batchSizes: report.batches.map((b) => b.length),
    config
  });
  return { ...comp, score: report.score };
}

export const BETA_SWEEP_GRID = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;

export interface BetaCell {
  beta: number;

  attainment: number;

  probes: number;

  reward: number;

  rounds: number;

  parallelPenalty: number;
}

export interface BetaSweepResult {
  cells: BetaCell[];

  auc: number;

  parallelPenalty: number;

  reward: number;

  degenerate: boolean;
}

export function betaSweepFromCells(
  cells: ReadonlyArray<{
    beta: number;
    attainment: number;
    probes: number;
    rounds: number;
    parallelPenalty: number;
  }>,
  lambda = 0
): BetaSweepResult {
  const ordered = [...cells].sort((a, b) => a.probes - b.probes || a.beta - b.beta);
  const maxProbes = Math.max(1, ...ordered.map((c) => c.probes));
  const maxAttain = Math.max(1e-12, ...ordered.map((c) => c.attainment));
  let auc = 0;
  let prevX = 0;
  let prevY = 0;
  for (const cell of ordered) {
    const x = cell.probes / maxProbes;
    const y = cell.attainment / maxAttain;

    auc += ((y + prevY) / 2) * Math.max(0, x - prevX);
    prevX = x;
    prevY = y;
  }

  auc += prevY * Math.max(0, 1 - prevX);
  const parallelPenalty =
    ordered.length === 0 ? 0 : ordered.reduce((a, c) => a + c.parallelPenalty, 0) / ordered.length;
  const distinct = new Set(ordered.map((c) => `${c.attainment.toFixed(6)}|${c.probes}`)).size;

  const withReward = ordered.map((c) => ({
    ...c,
    reward: c.probes > 0 ? c.attainment / c.probes : c.attainment
  }));
  return {
    cells: withReward,
    auc,
    parallelPenalty,
    reward: auc - lambda * parallelPenalty,
    degenerate: distinct <= 1
  };
}

export function scoreBetaCell(
  beta: number,
  reports: ReadonlyArray<ReplayReport>,
  baselineOf: (treeIndex: number) => number
): { beta: number; attainment: number; probes: number; rounds: number; parallelPenalty: number } {
  if (reports.length === 0) {
    return { beta, attainment: 0, probes: 0, rounds: 0, parallelPenalty: 0 };
  }
  let attainment = 0;
  let probes = 0;
  let rounds = 0;
  let seqRounds = 0;
  for (const report of reports) {
    const baseline = baselineOf(report.treeIndex);
    const scale = Math.max(Math.abs(baseline), 1);
    let best: number | null = null;
    for (const obs of report.revealed) {
      if (obs.score === null) continue;
      if (best === null || obs.score > best) best = obs.score;
    }
    const bestRaw = best ?? baseline;
    attainment += Number.isFinite(bestRaw) ? (bestRaw - baseline) / scale : 0;
    const n = report.n;
    probes += n;
    rounds += report.k;

    const w = Math.max(1, report.maxParallelism ?? 1);
    for (const batch of report.batches) {
      seqRounds += Math.max(1, Math.ceil(batch.length / w));
    }
  }
  return {
    beta,
    attainment: attainment / reports.length,
    probes,
    rounds,
    parallelPenalty: probes > 0 ? seqRounds / probes : 0
  };
}

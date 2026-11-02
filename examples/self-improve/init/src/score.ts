import type {
  DiscoveryTree,
  ReplayReport,
  ReplayScoreConfig
} from "./types.js";
import type { ReplayEnv } from "./env/replay.js";

export const DEFAULT_SCORE_CONFIG: ReplayScoreConfig = {
  beta1: 0.002,
  beta2: 0.01,
  normalize: "relativeToBaseline",
  rho: 0.5,
  lambda: 0.05
};

/** DREAM-RSI's budget-preference grid (paper Table 3 / DRSI_REPLAY_BETA_GRID). */
export const RHO_GRID = [0, 0.25, 0.5, 0.75, 1] as const;

export function withRho(
  config: ReplayScoreConfig,
  rho: number
): ReplayScoreConfig {
  return { ...config, rho };
}

export interface ScoreInput {
  baselineScore: number;
  revealedScores: Array<number | null>;
  rounds: number;
  config: ReplayScoreConfig;
}

export interface ScoreComponents {
  best: number;
  n: number;
  k: number;
  penalty: number;
  bonus: number;
  score: number;
}

export function normalizeScore(
  s: number,
  baseline: number,
  mode: ReplayScoreConfig["normalize"]
): number {
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
  // rho interpolates between "spend the whole budget for score" (0) and
  // "get the score in as few rounds as possible" (1). lambda penalises every
  // extra probe so parallelism pays only when it buys score.
  //
  // When nothing is revealed (n = 0) there is no exploration to score yet, so
  // the budget terms are zero: V is exactly the baseline under `none`.
  const rho = clamp01(config.rho ?? 0.5);
  const explored = n > 0;
  // Legacy terms (beta1 penalty, beta2 bonus) are kept intact so the classic
  // objective is a special case. rho and lambda add a budget-preference term:
  //   rho = 0 -> bonus for spending the budget (wide, deep exploration)
  //   rho = 1 -> bonus for solving in few rounds (efficiency)
  // The two terms are symmetric in magnitude so neither dominates.
  // The budget preference only applies when rho is explicitly set, so callers
  // that omit it get the classic objective bit-for-bit.
  const hasRho = typeof config.rho === "number";
  // lambda only applies when explicitly configured, so the classic objective
  // is reproduced exactly when callers omit rho and lambda.
  const lambda = config.lambda ?? 0;
  // Symmetric budget terms: `rho` trades spending the budget against solving
  // quickly, scaled by the fraction of the budget actually used. With no rho
  // configured both terms are zero and the classic objective is reproduced.
  //
  //   spend bonus = (1 - rho) * gamma * n
  //   speed penalty = rho * gamma * n / k
  //
  // At rho = 0 the policy is rewarded for spending probes; at rho = 1 it is
  // rewarded for reaching the same score in fewer rounds. gamma scales both.
  const gamma = hasRho ? 0.01 : 0;
  const spendTerm = hasRho ? (1 - rho) * gamma * n : 0;
  const speedTerm = hasRho && k > 0 ? (rho * gamma * n) / k : 0;
  const penalty = explored ? config.beta1 * n + lambda * n + speedTerm : 0;
  const bonus = explored ? (config.beta2 * n) / k + spendTerm : 0;
  return {
    best: bestNorm,
    n,
    k: rounds,
    penalty,
    bonus,
    score: bestNorm - penalty + bonus
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
    config
  });
  return {
    treeIndex: tree.treeIndex,
    policyId,
    score: error ? Number.NEGATIVE_INFINITY : comp.score,
    best: comp.best,
    n: comp.n,
    k: comp.k,
    batches: env.batchesTaken(),
    revealed,
    error,
    illegal,
    timedOut,
    wallMs
  };
}

/**
 * Mean V across a rho grid: a policy is scored by how it performs under every
 * budget preference, not just one. This is the DREAM-RSI selection objective.
 */
export function meanScoreOverGrid(
  reports: ReadonlyArray<ReplayReport>,
  config: ReplayScoreConfig,
  baselineOf: (treeIndex: number) => number,
  grid: readonly number[] = RHO_GRID
): number {
  if (reports.length === 0) return 0;
  const cells: number[] = [];
  for (const rho of grid) {
    const cfg = withRho(config, rho);
    let sum = 0;
    for (const report of reports) {
      if (!Number.isFinite(report.score)) {
        sum += Number.NEGATIVE_INFINITY;
        continue;
      }
      const comp = computeScore({
        baselineScore: baselineOf(report.treeIndex),
        revealedScores: report.revealed.map((o) => o.score),
        rounds: report.k,
        config: cfg
      });
      sum += comp.score;
    }
    cells.push(sum / reports.length);
  }
  return cells.reduce((a, b) => a + b, 0) / cells.length;
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

export function scoreReport(report: ReplayReport, config: ReplayScoreConfig, baseline: number): ScoreComponents {
  const comp = computeScore({
    baselineScore: baseline,
    revealedScores: report.revealed.map((o) => o.score),
    rounds: report.k,
    config
  });
  return { ...comp, score: report.score };
}

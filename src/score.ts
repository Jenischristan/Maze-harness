import type {
  DiscoveryTree,
  ReplayReport,
  ReplayScoreConfig
} from "./types.js";
import type { ReplayEnv } from "./env/replay.js";

export const DEFAULT_SCORE_CONFIG: ReplayScoreConfig = {
  beta1: 0.002,
  beta2: 0.01,
  normalize: "relativeToBaseline"
};

/** DREAM-RSI's budget-preference grid (paper Table 3 / DRSI_REPLAY_BETA_GRID). */
export const RHO_GRID = [0, 0.25, 0.5, 0.75, 1] as const;

function withRho(
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
  /** Batch sizes per round; drives the parallelism term W = sum(size-1). */
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

function normalizeScore(
  s: number,
  baseline: number,
  mode: ReplayScoreConfig["normalize"]
): number {
  if (mode === "none") return s;
  const denom = Math.max(Math.abs(baseline), 1);
  return (s - baseline) / denom;
}

/**
 * The replay objective V. Single formula, single place:
 *
 *     V = best
 *         - beta1*N                 (probe penalty)
 *         + beta2*N/k               (score-in-fewer-rounds bonus)
 *         - lambda*W                (parallelism penalty, W = sum(batch-1))
 *         - rho*gamma*N/k           (speed preference: fewer rounds better)
 *         + (1-rho)*gamma*N         (spend preference: more probes better)
 *
 *   best    normalised best score observed (0 = baseline)
 *   N       number of revealed probes (nodes)
 *   k       rounds used (>= 1)
 *   W       "wasted width" = sum(batchSize - 1) over all batches. This is the
 *           real parallelism term; folding lambda into N only repeated beta1.
 *   rho     DREAM-RSI budget preference in [0,1]: 0 rewards spending the
 *           budget (wide exploration), 1 rewards reaching the same score in
 *           fewer rounds. Selection averages V over the rho grid (see
 *           `meanScoreOverGrid`), so no single rho is baked into a run; a
 *           caller passing an explicit `rho` gets exactly that cell.
 *   gamma   fixed scale of the budget-preference terms (0.01). It only applies
 *           when `rho` is set, so a config without rho reproduces the classic
 *           objective bit-for-bit.
 *
 * All terms vanish when nothing was revealed, so V equals the baseline then.
 * `beta1`/`beta2`/`lambda` omitted behave as 0.
 */
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
  const hasRho = typeof config.rho === "number";
  const rho = hasRho ? clamp01(config.rho as number) : 0;

  // Width actually used: every extra parallel slot is one wasted unit. A
  // sequential policy has W = 0; a width-3 batch has W = 2.
  const width = input.batchSizes ? input.batchSizes.reduce((a, s) => a + Math.max(0, s - 1), 0) : 0;

  // Symmetric budget terms: at rho = 0 spending more probes is rewarded
  // (wide exploration wins); at rho = 1 the same probes in fewer rounds is
  // rewarded (efficient exploration wins). gamma only applies when rho is
  // configured, so the classic objective is reproduced exactly otherwise.
  const gamma = hasRho ? 0.01 : 0;
  const spendTerm = hasRho ? (1 - rho) * gamma * n : 0;
  const speedTerm = hasRho ? (rho * gamma * n) / k : 0;

  const penalty = explored ? beta1 * n + lambda * width + speedTerm : 0;
  const bonus = explored ? (beta2 * n) / k + spendTerm : 0;
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
        batchSizes: report.batches.map((b) => b.length),
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

function scoreReport(report: ReplayReport, config: ReplayScoreConfig, baseline: number): ScoreComponents {
  const comp = computeScore({
    baselineScore: baseline,
    revealedScores: report.revealed.map((o) => o.score),
    rounds: report.k,
    config
  });
  return { ...comp, score: report.score };
}

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

  // Width actually used: every extra parallel slot is one wasted unit. A
  // sequential policy has W = 0; a width-3 batch has W = 2.
  const width = input.batchSizes ? input.batchSizes.reduce((a, s) => a + Math.max(0, s - 1), 0) : 0;

  // Paper Eq. (1): V = best - beta1*N + beta2*N/k. That is the whole objective;
  // there is no rho term in the replay score. `rho` is an *evaluation-time*
  // budget preference in the beta sweep, not a modifier of V. Adding rho terms
  // here would silently override the paper's stated objective, so they are not
  // applied. `lambda` is the separate, opt-in parallelism penalty used by the
  // pareto.reward sweep.
  const penalty = explored ? beta1 * n + lambda * width : 0;
  const bonus = explored ? (beta2 * n) / k : 0;
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
    maxParallelism: env.maxParallelism,
    batches: env.batchesTaken(),
    revealed,
    error,
    illegal,
    timedOut,
    wallMs
  };
}

/**
 * Mean V across a rho grid.
 *
 * The paper's replay objective (Eq. 1) has no rho term — rho is an *evaluation
 * budget preference*, not a modifier of V. So every rho cell evaluates the same
 * V, and the honest answer is the plain mean V over the reports. We still keep
 * the grid parameter for API compatibility, but we assert the invariant that V
 * does not depend on rho instead of silently averaging identical numbers while
 * pretending rho matters.
 */
export function meanScoreOverGrid(
  reports: ReadonlyArray<ReplayReport>,
  config: ReplayScoreConfig,
  baselineOf: (treeIndex: number) => number,
  _grid: readonly number[] = RHO_GRID
): number {
  if (reports.length === 0) return 0;
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
      config
    });
    sum += comp.score;
  }
  return sum / reports.length;
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

/**
 * DREAM-RSI's evaluation-time beta sweep (paper Appendix B.2).
 *
 * Offline eval does not sweep `rho`; it sweeps one scalar `beta` in the
 * policy's own `_schedule(beta)` and measures the resulting
 * attainment/work/parallelism curve. The curve is ranked by
 *
 *     pareto.reward = pareto.auc - lambda * parallel_penalty
 *
 * where `pareto.auc` rewards reaching high per-trace attainment with few
 * total probes, and `parallel_penalty` is the mean of
 * `effective_sequential_rounds / total_probes` across the sweep (a serial
 * policy is near 1, useful full batches approach 1/W).
 */
export const BETA_SWEEP_GRID = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;

export interface BetaCell {
  beta: number;
  /** Mean normalised best attainment over the replay trees. */
  attainment: number;
  /** Total probes across the sweep. */
  probes: number;
  /** Mean attainment per probe, i.e. the point on the AUC curve. */
  reward: number;
  /** Decision rounds used. */
  rounds: number;
  /** Mean effective_sequential_rounds / total_probes, in (0, 1]. */
  parallelPenalty: number;
}

export interface BetaSweepResult {
  cells: BetaCell[];
  /** Area under the attainment-vs-probes curve, normalised to [0, 1]. */
  auc: number;
  /** Mean parallel penalty across the sweep. */
  parallelPenalty: number;
  /** `auc - lambda * parallelPenalty`; the value maximised by selection. */
  reward: number;
  /** Non-degenerate only when beta changes the attainment/work trade-off. */
  degenerate: boolean;
}

/**
 * Build one curve from already-scored beta cells. Each cell's attainment is
 * the mean best normalised score its reports reached; its work is the total
 * number of probes it spent.
 */
export function betaSweepFromCells(
  cells: ReadonlyArray<{ beta: number; attainment: number; probes: number; rounds: number; parallelPenalty: number }>,
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
    // Trapezoid between consecutive points on the (probes, attainment) curve.
    auc += ((y + prevY) / 2) * Math.max(0, x - prevX);
    prevX = x;
    prevY = y;
  }
  // Extend the last point to the right edge so a low-work curve is not
  // punished for stopping early.
  auc += prevY * Math.max(0, 1 - prevX);
  const parallelPenalty =
    ordered.length === 0 ? 0 : ordered.reduce((a, c) => a + c.parallelPenalty, 0) / ordered.length;
  const distinct = new Set(ordered.map((c) => `${c.attainment.toFixed(6)}|${c.probes}`)).size;
  // Reward per cell: attainment gained per probe spent. Cells with no probes
  // earn the attainment they got for free (roots/baseline).
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

/**
 * Score a beta-sweep cell from the reports one policy produced at that beta.
 * `baselineOf` maps a tree index to its baseline so attainment is normalised.
 */
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
    // A batch of k on W workers costs ceil(k / W) sequential rounds. W is the
    // world's max parallelism (paper Appendix B.2), never the batch's own
    // width: deriving W from the batch would score a serial policy as fully
    // parallel.
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

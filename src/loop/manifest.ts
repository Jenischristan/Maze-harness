import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../util/atomic.js";
import { CURRENT_SCHEMA, migrate, registerUpcaster, SchemaVersionError } from "../util/schema.js";
import type { DiscoveryTree } from "../types.js";

registerUpcaster("live-manifest", 1, (record) => {
  const { version: _legacy, ...rest } = record as { version?: unknown };
  return rest;
});

export interface LiveCycleManifest {
  schema: number;
  runId: string;
  round: number;
  treeIndex: number;
  policyId: string;

  plannedBranchCount: number;
  plannedRefineCount: number;
  planSource: "policy" | "fallback";
  planReason: string;

  effectiveBranchCount: number;
  effectiveRefineCount: number;
  probes: number;
  rounds: number;
  bestScore: number | null;
  baselineScore: number;

  beta: number | null;
  createdAt: string;
}

export type BetaSource = "insufficient-history" | "kept" | "raised" | "lowered";

export interface BetaSweepPoint {
  beta: number;
  paretoReward: number;
  auc: number;
  parallelPenalty: number;
}

export interface DefaultBetaDecision {
  beta: number;
  source: BetaSource;
  reason: string;

  looked: number;

  sweep: BetaSweepPoint[];
}

export const MODERATE_DEFAULT_BETA = 0.6;

export const BETA_STEP = 0.1;

export function manifestPath(dir: string, round: number): string {
  return join(dir, `t${String(round).padStart(4, "0")}-live_cycle_manifest.json`);
}

export async function saveLiveManifest(dir: string, manifest: LiveCycleManifest): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(
    manifestPath(dir, manifest.round),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await writeFileAtomic(join(dir, "_current"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function loadLiveManifests(dir: string): Promise<LiveCycleManifest[]> {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir))
    .filter((f) => /^t\d+-live_cycle_manifest\.json$/.test(f))
    .sort();
  const out: LiveCycleManifest[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, file), "utf8")) as Record<string, unknown>;

      out.push(migrate("live-manifest", raw) as unknown as LiveCycleManifest);
    } catch (err) {
      if (err instanceof SchemaVersionError) throw err;
    }
  }
  return out.sort((a, b) => a.round - b.round);
}

export async function loadBetaSweep(
  dir: string,
  round: number,
  policyId: string
): Promise<BetaSweepPoint[] | null> {
  const path = join(dir, `t${String(round).padStart(4, "0")}-${policyId}-beta_sweep.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      cells?: Array<{
        beta: number;
        reward: number;
        attainment: number;
        probes: number;
        parallelPenalty: number;
      }>;
      auc?: number;
      parallelPenalty?: number;
    };
    const auc = typeof raw.auc === "number" ? raw.auc : 0;
    const penalty = typeof raw.parallelPenalty === "number" ? raw.parallelPenalty : 0;
    return (raw.cells ?? []).map((c) => ({
      beta: c.beta,
      paretoReward: typeof c.reward === "number" ? c.reward : c.attainment / Math.max(1, c.probes),
      auc,
      parallelPenalty: c.parallelPenalty ?? penalty
    }));
  } catch {
    return null;
  }
}

export function chooseDefaultBeta(opts: {
  manifests: ReadonlyArray<LiveCycleManifest>;
  sweep: ReadonlyArray<BetaSweepPoint> | null;
  priorBeta: number | null;
}): DefaultBetaDecision {
  const window = opts.manifests.slice(-3);
  const sweep = opts.sweep ? [...opts.sweep].sort((a, b) => a.beta - b.beta) : [];
  if (window.length < 2) {
    return {
      beta: MODERATE_DEFAULT_BETA,
      source: "insufficient-history",
      reason: `only ${window.length} live manifest(s) available; use the moderately exploratory default ${MODERATE_DEFAULT_BETA}`,
      looked: window.length,
      sweep
    };
  }
  const last = window[window.length - 1]!;
  const prev = window[window.length - 2]!;
  const prior = clamp01(opts.priorBeta ?? last.beta ?? MODERATE_DEFAULT_BETA);
  const bestLast = last.bestScore ?? Number.NEGATIVE_INFINITY;
  const bestPrev = prev.bestScore ?? Number.NEGATIVE_INFINITY;
  const improving = bestLast > bestPrev;

  if (improving) {
    const better = bestNearby(sweep, prior);
    if (better !== null && better.paretoReward > bestAt(sweep, prior) + 1e-12) {
      return {
        beta: clamp01(better.beta),
        source: better.beta > prior ? "raised" : "lowered",
        reason: `live best improved (${fmt(bestPrev)} -> ${fmt(bestLast)}) and the sweep favors beta ${better.beta} over ${prior}`,
        looked: window.length,
        sweep
      };
    }
    return {
      beta: prior,
      source: "kept",
      reason: `live best still improving (${fmt(bestPrev)} -> ${fmt(bestLast)}); keep the prior default beta ${prior}`,
      looked: window.length,
      sweep
    };
  }

  const high = sweep.filter((p) => p.beta > prior + 1e-9);
  const low = sweep.filter((p) => p.beta < prior - 1e-9);
  const priorPoint = bestAt(sweep, prior);
  const bestHigh = high.reduce<BetaSweepPoint | null>(
    (best, p) => (best === null || p.paretoReward > best.paretoReward ? p : best),
    null
  );
  const bestLow = low.reduce<BetaSweepPoint | null>(
    (best, p) => (best === null || p.paretoReward > best.paretoReward ? p : best),
    null
  );
  if (bestHigh && bestHigh.paretoReward > priorPoint + 1e-12 && prior < 0.9) {
    return {
      beta: clamp01(Math.min(bestHigh.beta, prior + BETA_STEP)),
      source: "raised",
      reason: `live best plateaued at ${fmt(bestLast)}; higher-beta sweep points reach higher pareto.reward, so raise the default by one step`,
      looked: window.length,
      sweep
    };
  }
  if (bestLow && prior >= 0.5 && bestLow.paretoReward >= priorPoint - 1e-12) {
    return {
      beta: clamp01(Math.max(bestLow.beta, prior - BETA_STEP)),
      source: "lowered",
      reason: `live best plateaued at ${fmt(bestLast)} and high-beta points add work without higher attainment; lower the default by one step`,
      looked: window.length,
      sweep
    };
  }
  return {
    beta: prior,
    source: "kept",
    reason: `live best plateaued at ${fmt(bestLast)} and the sweep gives no clear direction; keep beta ${prior}`,
    looked: window.length,
    sweep
  };
}

function bestAt(sweep: ReadonlyArray<BetaSweepPoint>, beta: number): number {
  const exact = sweep.find((p) => Math.abs(p.beta - beta) < 1e-9);
  if (exact) return exact.paretoReward;
  if (sweep.length === 0) return Number.NEGATIVE_INFINITY;

  return sweep.reduce((best, p) =>
    Math.abs(p.beta - beta) < Math.abs(best.beta - beta) ? p : best
  ).paretoReward;
}

function bestNearby(sweep: ReadonlyArray<BetaSweepPoint>, beta: number): BetaSweepPoint | null {
  const nearby = sweep.filter((p) => Math.abs(p.beta - beta) <= BETA_STEP + 1e-9);
  if (nearby.length === 0) return null;
  return nearby.reduce((best, p) => (p.paretoReward > best.paretoReward ? p : best));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : "n/a";
}

export function manifestFromTree(opts: {
  runId: string;
  round: number;
  tree: DiscoveryTree;
  policyId: string;
  plan: { branchCount: number; refineCount: number; reason: string };
  planSource: "policy" | "fallback";
  beta: number | null;
  rounds: number;
}): LiveCycleManifest {
  const branches = new Set(opts.tree.nodes.map((n) => n.branch));
  let maxAttempt = 0;
  let best: number | null = null;
  for (const node of opts.tree.nodes) {
    maxAttempt = Math.max(maxAttempt, node.attempt);
    if (node.score !== null && (best === null || node.score > best)) best = node.score;
  }
  return {
    schema: CURRENT_SCHEMA,
    runId: opts.runId,
    round: opts.round,
    treeIndex: opts.tree.treeIndex,
    policyId: opts.policyId,
    plannedBranchCount: opts.plan.branchCount,
    plannedRefineCount: opts.plan.refineCount,
    planSource: opts.planSource,
    planReason: opts.plan.reason,
    effectiveBranchCount: branches.size,
    effectiveRefineCount: maxAttempt,
    probes: opts.tree.nodes.length,
    rounds: opts.rounds,
    bestScore: best,
    baselineScore: opts.tree.baselineScore,
    beta: opts.beta,
    createdAt: new Date().toISOString()
  };
}

/**
 * Fixed parallel refine policy (seed pi_1).
 *
 * Rules:
 * - Open up to `branches` independent branches from the root.
 * - In each round, refine the current leaf of every opened branch whose attempt
 *   count is still below `refinements`, highest score first.
 * - Use leftover slots to open another branch from the root while legal.
 * - Each probe returns a deterministic recorded observation in replay; the
 *   policy never reads anything outside `env`.
 *
 * Beta (paper Appendix B.2): `beta` in [0,1] is read once in the constructor and
 * routed through one `schedule()`. High beta means more width, deeper patience
 * and weaker pruning; low beta means fewer probes and earlier stopping. Beta is
 * fixed for the whole rollout and never adapted from observations inside
 * `solve()`.
 *
 * Grid planning (paper Appendix B.2): `planGrid(context)` runs before a new
 * live cycle and returns `GridPlan(branchCount, refineCount, reason)` on every
 * path. It uses only prefix-safe context facts, never a current episode's
 * outcomes.
 *
 * This file is loaded as *source text* by `src/policies/seed.ts` and compiled by
 * esbuild inside the replay sandbox, so it must stay import-free and
 * self-contained. `src/policies/fixedParallelRefine.ts` is the typed twin used
 * by the harness itself; `test/policies-parity.test.ts` pins them together.
 */
const ROOT = "root";

export default class FixedParallelRefine {
  private readonly branches: number;
  private readonly refinements: number;
  private readonly beta: number;

  constructor(config?: { branches?: number; refinements?: number; beta?: number }) {
    this.beta = Math.max(0, Math.min(1, config?.beta ?? 0.6));
    this.branches = Math.max(1, config?.branches ?? 3);
    this.refinements = Math.max(0, config?.refinements ?? 2);
  }

  /**
   * Route every behavioral threshold through one schedule. Called once per
   * decision context so beta has exactly one meaning inside an episode.
   */
  private schedule(maxParallelism: number, legalRootCap: number) {
    const b = this.beta;
    const branches = Math.max(1, Math.round(1 + b * 2));
    const refinements = Math.max(0, Math.round(b * 3));
    return {
      branches: Math.min(branches, Math.max(1, maxParallelism), Math.max(1, legalRootCap)),
      refinements,
      stopBelowBaseline: b < 0.35
    };
  }

  /**
   * Next-cycle grid plan. Widen when deepening plateaus, deepen when gains
   * arrive late on a stable set of branches, bootstrap conservatively when
   * history is thin. Always returns a plan.
   */
  planGrid(context: import("../../types.js").GridPlanningContext): import("../../types.js").GridPlan {
    const hardB = Math.max(1, context.hardMaxBranchCount);
    const hardR = Math.max(0, context.hardMaxRefineCount);
    const fallbackB = Math.min(hardB, Math.max(1, context.fallbackBranchCount));
    const fallbackR = Math.min(hardR, Math.max(0, context.fallbackRefineCount));
    const history = context.history;
    if (history.length < 2) {
      return {
        branchCount: fallbackB,
        refineCount: fallbackR,
        reason:
          "bootstrap: only " +
          history.length +
          " completed live cycle(s), so use the conservative fallback width/depth"
      };
    }
    const last = history[history.length - 1] as import("../../types.js").GridPlanningContext["history"][number];
    const prev = history[history.length - 2] as import("../../types.js").GridPlanningContext["history"][number];
    const bestLast = last.bestScore === null ? -Infinity : last.bestScore;
    const bestPrev = prev.bestScore === null ? -Infinity : prev.bestScore;
    const improving = bestLast > bestPrev;
    let rootChildren = 1;
    for (const r of context.replaySupport) rootChildren = Math.max(rootChildren, r.traceBranchCount);
    let maxRefine = 0;
    for (const r of context.replaySupport) maxRefine = Math.max(maxRefine, r.traceRefineCount);
    if (!improving && last.maxAttempt >= prev.maxAttempt) {
      return {
        branchCount: Math.min(hardB, Math.max(fallbackB, rootChildren + 1)),
        refineCount: Math.min(hardR, Math.max(0, Math.floor(prev.maxAttempt / 2))),
        reason:
          "plateau at max attempt " +
          last.maxAttempt +
          " with no live gain; widen branches and shallow the refine depth"
      };
    }
    if (improving && last.openedBranches <= prev.openedBranches) {
      return {
        branchCount: Math.min(hardB, Math.max(1, last.openedBranches)),
        refineCount: Math.min(hardR, Math.max(maxRefine, last.maxAttempt + 1)),
        reason:
          "live best improved on a stable set of " +
          last.openedBranches +
          " branches; keep width and deepen refinements"
      };
    }
    return {
      branchCount: Math.min(hardB, Math.max(1, last.plannedBranchCount)),
      refineCount: Math.min(hardR, Math.max(0, last.plannedRefineCount)),
      reason: "conflicting history: retain the previous planned width/depth"
    };
  }

  async solve(env: import("../../types.js").ExplorationEnv): Promise<void> {
    const legalRoots = env.legalRoots();
    const openCap = Number.isFinite(legalRoots) ? Math.max(1, legalRoots) : this.branches;
    const s = this.schedule(env.maxParallelism, openCap);
    const wantBranches = Math.min(s.branches, this.branches);
    const wantRefines = Math.min(s.refinements, this.refinements);
    for (let attempt = 0; attempt < Math.max(1, wantRefines); attempt += 1) {
      if (env.done || env.roundsRemaining <= 0) return;
      const batch = this.nextBatch(env, wantBranches, wantRefines, s.stopBelowBaseline);
      if (batch.length === 0) return;
      const obs = await env.probeBatch(batch);
      // A batch of non-root ids that produced nothing means the frontier is
      // stale; stop instead of spinning until the round budget runs out.
      if (obs.length === 0 && batch.every((id) => id !== ROOT)) return;
    }
    if (!env.done && env.roundsRemaining > 0) {
      const batch = this.openBranches(env, wantBranches);
      if (batch.length > 0) await env.probeBatch(batch);
    }
  }

  private openBranches(
    env: import("../../types.js").ExplorationEnv,
    branches: number = this.branches
  ): string[] {
    const opened = new Set<number>();
    for (const obs of env.observed().values()) opened.add(obs.branch);
    const want = Math.min(branches - opened.size, env.legalRoots());
    if (want <= 0) return [];
    return new Array<string>(Math.min(want, env.maxParallelism)).fill(ROOT);
  }

  private nextBatch(
    env: import("../../types.js").ExplorationEnv,
    branches: number = this.branches,
    refinements: number = this.refinements,
    stopBelowBaseline = false
  ): string[] {
    const leaves = this.frontier(env);
    const slots = Math.min(env.maxParallelism, branches);
    if (leaves.length === 0) return this.openBranches(env, branches).slice(0, slots);
    const byBranch = new Map<number, import("../../types.js").Observation>();
    for (const leaf of leaves) {
      const cur = byBranch.get(leaf.branch);
      if (!cur || leaf.seq > cur.seq) byBranch.set(leaf.branch, leaf);
    }
    const refine = [...byBranch.values()]
      .filter((leaf) => leaf.attempt < refinements)
      .filter((leaf) => {
        if (!stopBelowBaseline) return true;
        return (leaf.deltaVsBaseline === null ? -Infinity : leaf.deltaVsBaseline) > 0;
      })
      .sort((a, b) => (b.score === null ? -Infinity : b.score) - (a.score === null ? -Infinity : a.score))
      .slice(0, slots)
      .map((leaf) => leaf.id);
    const remaining = slots - refine.length;
    if (remaining <= 0) return refine;
    return [...refine, ...this.openBranches(env, branches).slice(0, remaining)];
  }

  private frontier(env: import("../../types.js").ExplorationEnv): import("../../types.js").Observation[] {
    const observed = env.observed();
    const parents = new Set<string>();
    for (const obs of observed.values()) parents.add(obs.parentId);
    const leaves: import("../../types.js").Observation[] = [];
    for (const obs of observed.values()) {
      if (!parents.has(obs.id)) leaves.push(obs);
    }
    return leaves;
  }
}

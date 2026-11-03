const ROOT = "root";

export default class FixedParallelRefine {
  private readonly branches: number;
  private readonly refinements: number;
  private readonly beta: number;
  private plan: { branchCount: number; refineCount: number } | null = null;

  constructor(config?: {
    branches?: number;
    refinements?: number;
    beta?: number;
    plan?: { branchCount: number; refineCount: number };
  }) {
    this.beta = Math.max(0, Math.min(1, config?.beta ?? 0.6));
    this.branches = Math.max(1, config?.branches ?? 3);
    this.refinements = Math.max(0, config?.refinements ?? 2);
    if (config?.plan) {
      this.plan = { branchCount: config.plan.branchCount, refineCount: config.plan.refineCount };
    }
  }

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

  planGrid(
    context: import("../../types.js").GridPlanningContext
  ): import("../../types.js").GridPlan {
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
    const last = history[
      history.length - 1
    ] as import("../../types.js").GridPlanningContext["history"][number];
    const prev = history[
      history.length - 2
    ] as import("../../types.js").GridPlanningContext["history"][number];
    const bestLast = last.bestScore === null ? -Infinity : last.bestScore;
    const bestPrev = prev.bestScore === null ? -Infinity : prev.bestScore;
    const improving = bestLast > bestPrev;
    let rootChildren = 1;
    for (const r of context.replaySupport)
      rootChildren = Math.max(rootChildren, r.traceBranchCount);
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

    const plan = this.plan;
    const wantBranches = plan
      ? Math.min(plan.branchCount, s.branches, this.branches)
      : Math.min(s.branches, this.branches);
    const refineCap = plan ? Math.min(plan.refineCount, this.refinements) : this.refinements;
    const wantRefines = Math.min(s.refinements, refineCap);
    for (let attempt = 0; attempt < Math.max(1, wantRefines); attempt += 1) {
      if (env.done || env.roundsRemaining <= 0) return;
      const batch = this.nextBatch(env, wantBranches, wantRefines, s.stopBelowBaseline);
      if (batch.length === 0) return;
      const obs = await env.probeBatch(batch);

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
      .sort(
        (a, b) =>
          (b.score === null ? -Infinity : b.score) - (a.score === null ? -Infinity : a.score)
      )
      .slice(0, slots)
      .map((leaf) => leaf.id);
    const remaining = slots - refine.length;
    if (remaining <= 0) return refine;
    return [...refine, ...this.openBranches(env, branches).slice(0, remaining)];
  }

  private frontier(
    env: import("../../types.js").ExplorationEnv
  ): import("../../types.js").Observation[] {
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

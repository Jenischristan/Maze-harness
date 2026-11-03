import { ROOT_ID } from "../tree.js";
import type { ExplorationEnv, ExplorationPolicy, Observation } from "../types.js";

export interface FixedParallelRefineConfig {
  branches: number;
  refinements: number;

  beta: number;

  plan?: { branchCount: number; refineCount: number };
}

function schedule(
  beta: number,
  maxParallelism: number,
  legalRootCap: number
): {
  branches: number;
  refinements: number;
  stopBelowBaseline: boolean;
} {
  const b = Math.max(0, Math.min(1, beta));

  const branches = Math.max(1, Math.round(1 + b * 2));
  const refinements = Math.max(0, Math.round(b * 3));
  return {
    branches: Math.min(branches, Math.max(1, maxParallelism), Math.max(1, legalRootCap)),
    refinements,
    stopBelowBaseline: b < 0.35
  };
}

export class FixedParallelRefine implements ExplorationPolicy {
  private readonly branches: number;
  private readonly refinements: number;
  private readonly beta: number;

  private plan: { branchCount: number; refineCount: number } | null = null;

  constructor(config: Partial<FixedParallelRefineConfig> = {}) {
    this.beta = Math.max(0, Math.min(1, config.beta ?? 0.6));
    this.branches = Math.max(1, config.branches ?? 3);
    this.refinements = Math.max(0, config.refinements ?? 2);

    if (config.plan) {
      this.plan = { branchCount: config.plan.branchCount, refineCount: config.plan.refineCount };
    }
  }

  planGrid(context: import("../types.js").GridPlanningContext): import("../types.js").GridPlan {
    const plan = this.computeGridPlan(context);

    this.plan = { branchCount: plan.branchCount, refineCount: plan.refineCount };
    return plan;
  }

  private computeGridPlan(
    context: import("../types.js").GridPlanningContext
  ): import("../types.js").GridPlan {
    const hardB = Math.max(1, context.hardMaxBranchCount);
    const hardR = Math.max(0, context.hardMaxRefineCount);
    const fallbackB = Math.min(hardB, Math.max(1, context.fallbackBranchCount));
    const fallbackR = Math.min(hardR, Math.max(0, context.fallbackRefineCount));
    const history = context.history;
    if (history.length < 2) {
      return {
        branchCount: fallbackB,
        refineCount: fallbackR,
        reason: `bootstrap: only ${history.length} completed live cycle(s), so use the conservative fallback width/depth`
      };
    }
    const last = history[history.length - 1]!;
    const prev = history[history.length - 2]!;
    const bestLast = last.bestScore ?? Number.NEGATIVE_INFINITY;
    const bestPrev = prev.bestScore ?? Number.NEGATIVE_INFINITY;
    const improving = bestLast > bestPrev;
    const rootChildren = Math.max(1, ...context.replaySupport.map((r) => r.traceBranchCount));
    const maxRefine = Math.max(0, ...context.replaySupport.map((r) => r.traceRefineCount));
    if (!improving && last.maxAttempt >= prev.maxAttempt) {
      return {
        branchCount: Math.min(hardB, Math.max(fallbackB, rootChildren + 1)),
        refineCount: Math.min(hardR, Math.max(0, Math.floor(prev.maxAttempt / 2))),
        reason: `plateau at max attempt ${last.maxAttempt} with no live gain; widen branches and shallow the refine depth`
      };
    }
    if (improving && last.openedBranches <= prev.openedBranches) {
      return {
        branchCount: Math.min(hardB, Math.max(1, last.openedBranches)),
        refineCount: Math.min(hardR, Math.max(maxRefine, last.maxAttempt + 1)),
        reason: `live best improved on a stable set of ${last.openedBranches} branches; keep width and deepen refinements`
      };
    }
    return {
      branchCount: Math.min(hardB, Math.max(1, last.plannedBranchCount)),
      refineCount: Math.min(hardR, Math.max(0, last.plannedRefineCount)),
      reason: "conflicting history: retain the previous planned width/depth"
    };
  }

  async solve(env: ExplorationEnv): Promise<void> {
    const openCap = Number.isFinite(env.legalRoots()) ? env.legalRoots() : this.branches;
    const s = schedule(this.beta, env.maxParallelism, Math.max(1, openCap));

    const plan = this.plan;
    const wantBranches = plan
      ? Math.min(plan.branchCount, this.branches, Math.max(1, openCap))
      : Math.min(s.branches, Math.max(1, openCap));
    const refineCap = plan ? Math.min(plan.refineCount, this.refinements) : this.refinements;
    const wantRefines = Math.min(s.refinements, refineCap);
    for (let attempt = 0; attempt < Math.max(1, wantRefines); attempt += 1) {
      if (env.done || env.roundsRemaining <= 0) return;
      const batch = this.nextBatch(env, wantBranches, wantRefines, s.stopBelowBaseline);
      if (batch.length === 0) return;
      const obs = await env.probeBatch(batch);
      if (obs.length === 0 && batch.every((id) => id !== ROOT_ID)) return;
    }
    if (!env.done && env.roundsRemaining > 0) {
      const batch = this.openBranches(env, wantBranches);
      if (batch.length > 0) await env.probeBatch(batch);
    }
  }

  private openBranches(env: ExplorationEnv, branches = this.branches): string[] {
    const opened = new Set<number>();
    for (const obs of env.observed().values()) opened.add(obs.branch);
    const want = Math.min(branches - opened.size, env.legalRoots());
    return want > 0 ? new Array<string>(Math.min(want, env.maxParallelism)).fill(ROOT_ID) : [];
  }

  private nextBatch(
    env: ExplorationEnv,
    branches = this.branches,
    refinements = this.refinements,
    stopBelowBaseline = false
  ): string[] {
    const leaves = this.frontier(env);
    const slots = Math.min(env.maxParallelism, branches);
    if (leaves.length === 0) {
      return this.openBranches(env, branches).slice(0, slots);
    }
    const byBranch = new Map<number, Observation>();
    for (const leaf of leaves) {
      const cur = byBranch.get(leaf.branch);
      if (!cur || leaf.seq > cur.seq) byBranch.set(leaf.branch, leaf);
    }
    const refine = [...byBranch.values()]
      .filter((leaf) => leaf.attempt < refinements)
      .filter((leaf) => {
        if (!stopBelowBaseline) return true;
        return (leaf.deltaVsBaseline ?? -Infinity) > 0;
      })
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, slots)
      .map((leaf) => leaf.id);
    const remaining = slots - refine.length;
    if (remaining > 0) {
      const roots = this.openBranches(env, branches).slice(0, remaining);
      return [...refine, ...roots];
    }
    return refine;
  }

  private frontier(env: ExplorationEnv): Observation[] {
    const observed = env.observed();
    const parents = new Set<string>();
    for (const obs of observed.values()) parents.add(obs.parentId);
    const leaves: Observation[] = [];
    for (const obs of observed.values()) {
      if (!parents.has(obs.id)) leaves.push(obs);
    }
    return leaves;
  }
}

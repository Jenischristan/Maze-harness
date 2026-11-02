import { ROOT_ID } from "../tree.js";
import type { ExplorationEnv, ExplorationPolicy, Observation } from "../types.js";

export interface FixedParallelRefineConfig {
  branches: number;
  refinements: number;
}

/**
 * Typed fixed-parallel-refine policy.
 *
 * There used to be two implementations of this algorithm: this class and
 * `src/policies/variants/fixed.ts`, which `seed.ts` loads as *source text* for
 * the replay sandbox. They drifted (the variant lacked the stale-frontier
 * guard), so the same policy id could behave differently depending on which one
 * ran.
 *
 * The variant must stay import-free because esbuild compiles it from an
 * arbitrary working directory inside the sandbox, so it cannot simply
 * re-export this class. This class is therefore the reference implementation
 * and `test/policies-parity.test.ts` compiles the variant source and asserts
 * both pick identical batches on the same synthetic trees.
 */
export class FixedParallelRefine implements ExplorationPolicy {
  private readonly branches: number;
  private readonly refinements: number;

  constructor(config: Partial<FixedParallelRefineConfig> = {}) {
    this.branches = Math.max(1, config.branches ?? 3);
    this.refinements = Math.max(0, config.refinements ?? 2);
  }

  async solve(env: ExplorationEnv): Promise<void> {
    for (let attempt = 0; attempt < this.refinements; attempt += 1) {
      if (env.done || env.roundsRemaining <= 0) return;
      const batch = this.nextBatch(env);
      if (batch.length === 0) return;
      const obs = await env.probeBatch(batch);
      if (obs.length === 0 && batch.every((id) => id !== ROOT_ID)) return;
    }
    if (!env.done && env.roundsRemaining > 0) {
      const batch = this.openBranches(env);
      if (batch.length > 0) await env.probeBatch(batch);
    }
  }

  private openBranches(env: ExplorationEnv): string[] {
    const opened = new Set<number>();
    for (const obs of env.observed().values()) opened.add(obs.branch);
    const want = Math.min(this.branches - opened.size, env.legalRoots());
    return want > 0 ? new Array<string>(Math.min(want, env.maxParallelism)).fill(ROOT_ID) : [];
  }

  private nextBatch(env: ExplorationEnv): string[] {
    const leaves = this.frontier(env);
    const slots = Math.min(env.maxParallelism, this.branches);
    if (leaves.length === 0) {
      return this.openBranches(env).slice(0, slots);
    }
    const byBranch = new Map<number, Observation>();
    for (const leaf of leaves) {
      const cur = byBranch.get(leaf.branch);
      if (!cur || leaf.seq > cur.seq) byBranch.set(leaf.branch, leaf);
    }
    const refine = [...byBranch.values()]
      .filter((leaf) => leaf.attempt < this.refinements)
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, slots)
      .map((leaf) => leaf.id);
    const remaining = slots - refine.length;
    if (remaining > 0) {
      const roots = this.openBranches(env).slice(0, remaining);
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


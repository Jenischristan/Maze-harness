import { ROOT_ID } from "../tree.js";
import type { ExplorationEnv, ExplorationPolicy, Observation } from "../types.js";

export interface FixedParallelRefineConfig {
  branches: number;
  refinements: number;
}

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

export default FixedParallelRefine;

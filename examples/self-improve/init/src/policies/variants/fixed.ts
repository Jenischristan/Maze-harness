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
 */
const ROOT = "root";

export default class FixedParallelRefine {
  private readonly branches: number;
  private readonly refinements: number;

  constructor(config?: { branches?: number; refinements?: number }) {
    this.branches = Math.max(1, config?.branches ?? 3);
    this.refinements = Math.max(0, config?.refinements ?? 2);
  }

  async solve(env: import("../../types.js").ExplorationEnv): Promise<void> {
    for (let attempt = 0; attempt < this.refinements; attempt += 1) {
      if (env.done || env.roundsRemaining <= 0) return;
      const batch = this.nextBatch(env);
      if (batch.length === 0) return;
      await env.probeBatch(batch);
    }
    if (!env.done && env.roundsRemaining > 0) {
      const batch = this.openBranches(env);
      if (batch.length > 0) await env.probeBatch(batch);
    }
  }

  private openBranches(env: import("../../types.js").ExplorationEnv): string[] {
    const opened = new Set<number>();
    for (const obs of env.observed().values()) opened.add(obs.branch);
    const want = Math.min(this.branches - opened.size, env.legalRoots());
    if (want <= 0) return [];
    return new Array<string>(Math.min(want, env.maxParallelism)).fill(ROOT);
  }

  private nextBatch(env: import("../../types.js").ExplorationEnv): string[] {
    const leaves = this.frontier(env);
    const slots = Math.min(env.maxParallelism, this.branches);
    if (leaves.length === 0) return this.openBranches(env).slice(0, slots);
    const byBranch = new Map<number, import("../../types.js").Observation>();
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
    if (remaining <= 0) return refine;
    return [...refine, ...this.openBranches(env).slice(0, remaining)];
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

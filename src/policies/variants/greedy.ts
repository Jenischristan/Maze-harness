const ROOT = "root";

export default class GreedyPrefixPolicy {
  async solve(env: import("../../types.js").ExplorationEnv): Promise<void> {
    const attempted = new Set();
    const W = Math.max(1, env.maxParallelism);

    const opening = Math.min(W, env.legalRoots());
    if (opening > 0 && env.roundsRemaining > 0) {
      await env.probeBatch(new Array(opening).fill(ROOT));
    }

    while (!env.done && env.roundsRemaining > 0) {
      const observed = env.observed();
      const parents = new Set();
      for (const obs of observed.values()) {
        if (obs.parentId !== ROOT) parents.add(obs.parentId);
      }
      const leaves = [];
      for (const obs of observed.values()) {
        if (!parents.has(obs.id)) leaves.push(obs);
      }
      if (leaves.length === 0) return;

      const byBranch = new Map();
      for (const leaf of leaves) {
        const cur = byBranch.get(leaf.branch);
        if (!cur || leaf.seq > cur.seq) byBranch.set(leaf.branch, leaf);
      }
      const ranked = [...byBranch.values()].sort((a, b) => {
        const sa = a.score === null ? -1e9 : a.score;
        const sb = b.score === null ? -1e9 : b.score;
        if (sb !== sa) return sb - sa;
        return a.attempt - b.attempt;
      });

      const batch = [];
      let recoveryUsed = false;
      for (const leaf of ranked) {
        if (batch.length >= W) break;
        if (attempted.has(leaf.id)) continue;
        const isRecovery = !leaf.valid;
        if (isRecovery && recoveryUsed) continue;
        if (isRecovery) recoveryUsed = true;
        batch.push(leaf.id);
        attempted.add(leaf.id);
      }

      if (batch.length === 0) {
        const fresh = leaves.filter((l) => !attempted.has(l.id))[0];
        if (!fresh) {
          if (env.legalRoots() > 0) {
            await env.probeBatch([ROOT]);
            continue;
          }
          return;
        }
        attempted.add(fresh.id);
        batch.push(fresh.id);
      }
      await env.probeBatch(batch);
    }
  }
}

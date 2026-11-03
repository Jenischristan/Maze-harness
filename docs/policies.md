# Writing an exploration policy

Human-facing tutorial for the policy interface. The machine-facing prompt used
by the automatic developer is `prompts/policy-developer.md`; the authoritative
types are in `src/types/dream.ts`.

## What a policy is

An exploration policy decides **where to spend discovery attempts**. It does not
solve the task. It sees a growing tree of recorded attempts and chooses a batch
of nodes to probe next.

```ts
export default class MyPolicy {
  constructor(config = {}) {
    this.beta = Math.max(0, Math.min(1, config.beta ?? 0.6));
    this.plan = config.plan; // effective grid plan for this cycle, if any
  }

  async solve(env) {
    while (!env.done && env.roundsRemaining > 0) {
      const batch = this.choose(env);
      if (batch.length === 0) return;
      await env.probeBatch(batch);
    }
  }
}
```

`solve` is called once per rollout. It must terminate on its own: return when
there is nothing worth probing, or when the environment is done.

## The environment

| Member             | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `baselineScore`    | score of the initial workspace                                  |
| `maxParallelism`   | `W`, the most ids one batch may contain                         |
| `roundsRemaining`  | decision rounds left                                            |
| `done`             | the environment is closed                                       |
| `observed()`       | map of revealed id to `Observation` (never unrevealed nodes)    |
| `legalActions()`   | `["root", ...current leaf ids]`                                 |
| `legalRoots()`     | replay: unrevealed root children; live: plan's remaining width  |
| `openedBranches()` | branch ids the policy has observed                              |
| `meta(id)`         | structural fields only: `.branch .attempt .parentId .seq .tags` |
| `probeBatch(ids)`  | reveal the recorded children; consumes one round                |
| `priorHistory()`   | summaries of earlier trees (read-only)                          |
| `reset()`          | clear the observed prefix back to the root                      |

`bestSoFar` and `budgetSpent` exist for bookkeeping only. **Do not use them to
decide what to explore**; derive decisions from `observed()`.

### Batch rules

- At most `maxParallelism` ids.
- Every id must be in `legalActions()`.
- `root` may appear several times in one batch; each occurrence opens one new
  branch, only while `legalRoots() > 0`.
- Leaf ids must be distinct within a batch.
- An empty batch means stop.
- `probeBatch` consumes exactly one round even if a slot reveals nothing.
- Violating any rule scores `-Infinity` on that tree.

## Observations

`Observation` carries `id`, `branch`, `attempt`, `parentId`, `seq`, `score`,
`valid`, `failClass`, `error`, `deltaVsBaseline`, `deltaVsParent`, `nValid`,
`nTotal`, `tags`, plus the paper's signals:

| Signal               | True when                                                                   |
| -------------------- | --------------------------------------------------------------------------- |
| `branchPromising`    | the branch produced a successful probe that beat its parent or the baseline |
| `branchFailedHard`   | at least two same-class failures on the branch with no prior success        |
| `improvedVsParent`   | this probe's score is strictly above its parent (baseline for a root child) |
| `improvedVsBaseline` | this probe's score is strictly above the baseline                           |

**Success semantics.** `error === null` and `failClass === "ok"` is a successful
evaluation, _even when_ `valid` is false. Never treat `valid: false` alone as a
repairable failure.

## The plan is a hard bound

The runner computes a `GridPlan { branchCount, refineCount, reason }` before
each live cycle and hands the effective plan to the driving policy through its
constructor as `config.plan`. Replay constructs a fresh instance per tree and
never calls `planGrid` on it, so a policy that only remembers the plan on
`this` from a `planGrid` call loses it in replay.

Read `config.plan` in the constructor and treat it as a bound: never open more
than `plan.branchCount` branches, never refine past `plan.refineCount`
attempts. `LiveEnv` and the score both assume this.

## Beta: one fixed knob per episode

Read one scalar in the constructor and route every threshold through it.

```ts
beta = Math.max(0, Math.min(1, config.beta ?? 0.6));
```

- **Within an episode** beta is fixed. High beta means more width, deeper
  patience, weaker pruning. Low beta means fewer probes, earlier stops,
  stronger pruning. Never change beta from observations inside `solve()`.
- **Offline** the harness sweeps a fixed beta grid and ranks the resulting
  attainment/work/parallelism curve. A policy that ignores beta yields a flat
  (degenerate) sweep and cannot be ranked on it.
- **Between cycles** the runner picks the baked-in default beta from live
  manifests and archived sweeps, then passes it to the constructor.

## Minimal example

```ts
const ROOT = "root";

export default class RefineBest {
  constructor(config = {}) {
    this.beta = Math.max(0, Math.min(1, config.beta ?? 0.6));
    this.plan = config.plan ?? null;
  }

  async solve(env) {
    const width = this.plan ? this.plan.branchCount : Math.min(3, env.maxParallelism);
    const depth = this.plan ? this.plan.refineCount : this.beta < 0.4 ? 1 : 3;

    // Open branches.
    const open = Math.min(width, env.legalRoots(), env.maxParallelism);
    if (open > 0) await env.probeBatch(new Array(open).fill(ROOT));

    while (!env.done && env.roundsRemaining > 0) {
      const best = [...env.observed().values()]
        .filter((o) => o.attempt < depth)
        .filter((o) => env.legalActions().includes(o.id))
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))[0];
      if (!best) return;
      await env.probeBatch([best.id]);
    }
  }

  planGrid(context) {
    // Must return a non-null plan on every path.
    const width = Math.min(context.fallbackBranchCount, context.hardMaxBranchCount);
    const depth = Math.min(context.fallbackRefineCount, context.hardMaxRefineCount);
    return {
      branchCount: Math.max(1, width),
      refineCount: Math.max(0, depth),
      reason: "bootstrap"
    };
  }
}
```

## Checklist before shipping a policy

- [ ] `solve` terminates without relying on a round cap.
- [ ] Every batch is legal before the call: ids in `legalActions()`, no
      duplicates, at most `maxParallelism`, `root` only while `legalRoots() > 0`.
- [ ] The plan from `config.plan` bounds width and depth.
- [ ] Beta is read once and never mutated inside `solve`.
- [ ] No randomness, clock, filesystem or network.
- [ ] No unrevealed data, hard-coded cell ids, or absolute score targets.
- [ ] `planGrid` returns a non-null plan with a factual reason on every path.
- [ ] `valid: false` alone is not treated as a repairable failure.
- [ ] A later success reopens a branch that an earlier failure closed.

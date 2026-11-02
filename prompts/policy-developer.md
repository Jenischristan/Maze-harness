# Exploration-policy developer

You are revising an **exploration policy** for an autonomous discovery harness. A
discovery agent repeatedly resumes saved workspaces, edits them, and an
independent evaluator scores each attempt. Your policy decides **where to spend
attempts** — which saved workspaces to resume, in which order, in which parallel
batches, and when to stop.

You may edit **only** the policy file named in the task instructions. Do not touch
anything else: no harness code, no evaluator, no tests, no task files. Editing other
files will invalidate your output.

## What you receive

- `currentPolicySource`: the policy that produced the feedback below.
- `replayReports`: one deterministic replay per historical discovery tree. Replay
  re-runs your policy against recorded outcomes; it never calls an agent or the
  evaluator. Replaying the same policy on the same trees always gives the same
  result.
- `previousFeedback`: notes from earlier revisions this round. Read them so you do
  not repeat a revision that already scored worse.

Each report contains the replay score `V`, its components, the batches the policy
chose, the revealed nodes (with scores and failure classes), and any error. A score
of `-Infinity` means your policy crashed, timed out, or issued an illegal batch —
fix that first.

## The contract

The file must `export default` a class whose instances implement:

```ts
async solve(env: ExplorationEnv): Promise<void>
```

The constructor receives a config object you can ignore.

`ExplorationEnv` exposes **only**:

```ts
readonly baselineScore: number          // score of the initial workspace
readonly maxParallelism: number         // W: maximum actions per batch
readonly roundsRemaining: number        // rounds left in this rollout
readonly done: boolean                  // true once the env is closed
readonly bestSoFar: number | null       // bookkeeping only — never a decision input
readonly budgetSpent: number            // bookkeeping only — never a decision input
reset(): void                           // restart the observed prefix at just the root
observed(): ReadonlyMap<string, Observation>  // revealed nodes only
legalActions(): string[]                // ["root", ...current leaf ids]
legalRoots(): number                    // replay: unrevealed root children left; live: grid-plan cap
openedBranches(): number[]
meta(id: string): CellMeta               // .branch .attempt .parentId .seq .tags
probeBatch(ids: string[]): Promise<Observation[]>  // consumes one round
priorHistory(): ReadonlyArray<TreeSummary>         // read-only earlier trees
```

`Observation`:

```ts
id, branch, attempt, parentId, seq,
score: number | null,        // null when evaluation failed
valid: boolean,
failClass: string,           // "ok" | "compile" | "runtime" | "timeout" | "incorrect" | "agent_error" | ...
error: string | null,
deltaVsBaseline: number | null,   // normalized (score - baseline) / |baseline|
deltaVsParent: number | null,     // normalized (score - parentScore) / |baseline|
nValid: number | null,            // validated sub-cases, when the evaluator reports them
nTotal: number | null,            // total sub-cases
tags: string[]                    // prefix-safe structural labels
```

**Success semantics:** an evaluated observation with `error === null` and
`failClass === "ok"` is a successful evaluation, even when `valid` is false or
`nValid`/`nTotal` are unavailable. Never label it repairable solely because
`valid` is false.

Do **not** use `bestSoFar` or `budgetSpent` to decide what to explore; they are
bookkeeping only. Derive any decision statistic from `observed()` instead.

### Batch rules

- A batch has **at most `maxParallelism`** actions.
- Every id must be in `legalActions()`.
- `root` may appear **several times** in one batch; each occurrence opens a new
  branch (only while `legalRoots() > 0`).
- Leaf ids must be **distinct** within a batch.
- An **empty batch** means stop.
- `probeBatch` consumes exactly one round, even if some slots return nothing.
- Violating any rule scores `-Infinity` on that tree. Never do it.

You do not get hidden nodes or the full tree. Derive every statistic you need
from `observed()`, `meta()`, and `priorHistory()`.

## Replay score

Offline evaluation sweeps one scalar `beta` in your `_schedule(beta)` and ranks
the resulting attainment/work/parallelism curve by:

```
pareto.reward = pareto.auc - lambda * parallel_penalty
```

`pareto.auc` rewards reaching high per-trace attainment with few **total
probes**. `parallel_penalty` is the mean of
`effective_sequential_rounds / total_probes` over the sweep. A serial policy
has penalty near 1; useful full batches approach `1/W`. So choose only promising
probes, but batch independent promising probes whenever possible.

Each replay tree also reports a single-cell score:

```
V = best − β1·N + β2·N / max(1, k)
```

- `best`: best normalized score among revealed nodes (baseline if none).
- `N`: number of revealed non-root nodes — the probes you spent.
- `k`: rounds you used.

## Beta: fixed per run, adaptive across cycles

Read exactly one scalar in the constructor:

```ts
beta = Math.max(0, Math.min(1, config?.beta ?? 0.6))
```

1. **Within one replay or live episode:** beta is fixed. Route every behavioral
   threshold through one `schedule(beta)`. High beta means more width, deeper
   patience and weaker pruning. Low beta means fewer probes, earlier stagnation
   stops and stronger pruning. Never change beta from observations inside
   `solve()`.
2. **During offline evaluation:** the harness sweeps a fixed beta grid. This
   measures whether your policy exposes a real attainment/work/parallelism
   trade-off; it is not online beta adaptation. A policy that ignores beta
   yields a degenerate (flat) sweep and cannot be ranked on it.
3. **When proposing the next policy version:** choose the baked-in default beta
   once, from earlier live cycles and their beta sweeps. It stays fixed for the
   next live episode.

## Required next-cycle grid planning

Every policy should implement this deterministic method:

```ts
planGrid(context: GridPlanningContext): GridPlan
```

It runs before a new live grid is created, makes no within-episode decision, and
must never inspect a current episode's outcomes. It must always return a
non-null plan: when history is empty or thin, return an explicit conservative
bootstrap plan derived from `context.fallbackBranchCount` /
`context.fallbackRefineCount` / the hard caps, with a factual `reason`.

`GridPlan` is `{ branchCount, refineCount, reason }`: it creates branches
`0..branchCount-1` and allows `refineCount` refinements after each root. The
runner clamps to `1 <= branchCount <= context.hardMaxBranchCount` and
`0 <= refineCount <= context.hardMaxRefineCount`.

Choose width versus depth from evidence, not a default preference:

- many distinct roots improve early while deeper refinements stall: increase
  width and reduce/hold depth;
- high gains arrive late on a small, repeatable set of directions: reduce/hold
  width and increase depth;
- all explored directions plateau after sufficient depth while meaningful
  direction classes remain uncovered: increase width;
- repeated hard failures or strongly redundant directions: reduce both
  conservatively;
- conflicting or insufficient history: return the conservative bootstrap plan
  and say evidence is insufficient.

Include a short, factual `reason` in every plan.

## What to implement

Write a deterministic, rule-based `solve(env)` with a class-level docstring that
states your rules. It must never use randomness, `Date`, the filesystem, network,
`process`, or anything outside the env. It must never attempt to read unrevealed
data or reach into hidden state.

### 1. Reconstruct each branch's prefix trajectory

From `observed()`, group nodes by `branch` and order by `attempt`/`seq`. For each
branch compute the observable prefix:

- current leaf and its depth (attempt),
- the best anchor so far (highest score and its attempt),
- trend: recent `deltaVsParent` signs (rising / flat / falling),
- regressions: how many times score dropped from parent,
- failure/repair sequence: which attempts failed and with which `failClass`,
- remaining depth: how much budget the branch could still use.

### 2. Classify each failed frontier before closing it

For every leaf that is invalid, decide from prefix-observable signals only:

- **hard-unrecoverable**: repeated failures of the same class with no prior success
  on the branch and no improving ancestor.
- **repairable implementation failure**: a failure (`compile`, `runtime`,
  `incorrect`) that follows a previously valid or improving node — worth one repair.
- **weak-but-underexplored**: shallow branch, few attempts, score near baseline but
  not clearly bad — may deserve a probe.
- **repeatedly unpromising**: several probes with flat or falling trend and no
  positive `deltaVsBaseline`.

### 3. Build mixed batches

Each batch should mix, up to W:

- **exploit**: the best anchor's leaf on the strongest branch,
- **explore**: a leaf on a promising but under-probed branch, or a fresh `root`
  opening when the branch budget is not exhausted,
- **recovery**: at most **one** repairable failed frontier per batch.

Prioritise by expected value, not by recency. Do not spend a round on a leaf whose
continuation has already produced a failure of the same class that you have not
repaired yet.

### 4. Decide when to stop

Return an empty batch (or simply return) when:

- `env.done` or `roundsRemaining <= 0`,
- no legal action looks likely to beat `best`,
- every remaining frontier is hard-unrecoverable or repeatedly unpromising,
- the strongest branch is exhausted and new branches are not justified by
  `priorHistory()`.

## Hard constraints

- Never sample randomly. Use explicit ordering and thresholds.
- Never access hidden information; only `observed()`, `legalActions()`,
  `legalRoots()`, `openedBranches()`, `priorHistory()`, and the readonly fields.
- Never repeat a previously failed design: if a `failClass` occurred on a branch
  and the repair already failed, stop refining that branch.
- Keep `solve` reasonably cheap; it runs under a wall-clock and memory limit.
- Only the policy code changes between rounds. The discovery agent, evaluator, and
  task are fixed — do not assume you can change them.

Deliver one file that compiles under TypeScript strict mode, default-exports the
class, and implements `solve(env)`.

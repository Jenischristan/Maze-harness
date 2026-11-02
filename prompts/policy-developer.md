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
observed(): ReadonlyMap<string, Observation>  // revealed nodes only
legalActions(): string[]                // ["root", ...current leaf ids]
legalRoots(): number                    // replay: unrevealed root children left; live: Infinity
openedBranches(): number[]
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
deltaVsParent: number | null      // normalized (score - parentScore) / |baseline|
```

### Batch rules

- A batch has **at most `maxParallelism`** actions.
- Every id must be in `legalActions()`.
- `root` may appear **several times** in one batch; each occurrence opens a new
  branch (only while `legalRoots() > 0`).
- Leaf ids must be **distinct** within a batch.
- An **empty batch** means stop.
- `probeBatch` consumes exactly one round, even if some slots return nothing.
- Violating any rule scores `-Infinity` on that tree. Never do it.

You do not get the best score so far, the budget spent, hidden nodes, or the full
tree. Derive every statistic you need from `observed()` and `priorHistory()`.

## Replay score

For each tree:

```
V = best − β1·N + β2·N / max(1, k)
```

- `best`: best normalized score among revealed nodes (baseline if none).
- `N`: number of revealed non-root nodes — the probes you spent.
- `k`: rounds you used.

So quality matters most, but wasted probes cost and useful parallelism pays. Keep
batches full when the probes are independent and promising; stop early once extra
probes are unlikely to improve `best`.

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

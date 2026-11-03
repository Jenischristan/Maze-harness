# Architecture

This document explains how `maze-harness` is put together: the layers, the
data that flows between them, and the invariants each layer is responsible
for. Read it before changing anything under `src/loop`, `src/env` or
`src/policies`.

## Two systems in one repository

The repository contains a general coding harness and the Dream-RSI loop built
on top of it. They share the tool layer, provider layer, session store and
cost tracking.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Dream-RSI loop  (src/loop)                                           │
│   runDream: online rollout → offline replay → policy revision →      │
│             selection → redeploy                                     │
│   Depends on: LiveEnv, ReplayEnv, policy sandbox, score, manifests   │
└──────────────────────────────────────────────────────────────────────┘
             │ online                         │ offline
             ▼                                ▼
┌──────────────────────────┐     ┌────────────────────────────────────┐
│ LiveEnv (src/env/live)   │     │ ReplayEnv (src/env/replay)         │
│ real agent + evaluator,  │     │ deterministic replay over a        │
│ git worktree per attempt │     │ recorded DiscoveryTree             │
└──────────────────────────┘     └────────────────────────────────────┘
             │                                │
             └────────────┬───────────────────┘
                          ▼
              ┌───────────────────────────┐
              │ ExplorationEnv contract   │  (src/types/dream.ts)
              │ solve(env) lives here     │
              └───────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Coding harness                                                       │
│   agent loop · native provider (3 wire protocols) · tools · sessions │
│   compaction · permissions · hooks · cost · sub-agents · MCP · skills│
└──────────────────────────────────────────────────────────────────────┘
```

Only the **exploration policy** changes between Dream rounds. The discovery
agent, evaluator, task and tool layer are fixed.

## Layers

### 1. Types (`src/types/`)

The shared contract. Split into `dream.ts` (trees, env, replay, policies),
`tool.ts`, `chat.ts` and `session.ts`, re-exported from `src/types.ts`.
`ExplorationEnv`, `Observation` and `GridPlan` mirror the paper's Appendix B.2
API; treat them as public interface.

### 2. Utilities (`src/util/`)

Cross-cutting primitives with no dependency on the rest of the system:

| Module         | Responsibility                                          |
| -------------- | ------------------------------------------------------- |
| `logger.ts`    | leveled logging, text/JSON formats, correlation context |
| `redact.ts`    | secret scrubbing for every persisted/printed string     |
| `env.ts`       | allowlisted environment for child processes             |
| `args.ts`      | shell-like / JSON argv parsing                          |
| `limits.ts`    | per-task turn/token/wall/USD/tool-call budgets          |
| `retry.ts`     | jittered backoff + circuit breaker                      |
| `schema.ts`    | persisted-record versioning and migrations              |
| `integrity.ts` | JSONL hashing and corruption reporting                  |
| `lock.ts`      | exclusive, PID-stamped run lock                         |
| `atomic.ts`    | atomic file writes and torn-line recovery               |
| `stream.ts`    | UTF-8-safe bounded output collection                    |

### 3. Tools (`src/tools/`)

`read`, `grep`, `glob`, `edit`, `apply_patch`, `write`, `bash`, `page`,
`fetch`. `ToolRegistry` holds definitions; `ToolExecutor` runs a batch
(read-only in parallel, mutating sequentially), enforces loop detection,
validates arguments against the tool's JSON schema, and runs verification
hooks after any mutation.

Invariants:

- `edit`, `apply_patch` and `write` refuse to touch a file that was not read in
  the session, or that changed since it was read.
- `resolveInside` rejects lexical and symlink escapes.
- Every tool result is data, never instructions, and is redacted on the way to
  disk.

### 4. Agent (`src/agent/`, `src/agents/`)

`runAgentLoop` is the turn loop: compact → request → persist → execute tools →
verify → repeat. It enforces `maxTurns` and the token/wall/USD/tool-call
budget, detects repeated tool batches, can snapshot before a mutating batch
and rewind on failure, and persists every message and result to the session.

`provider.ts` is the OpenAI-compatible client: request translation, thinking
fields per vendor, retry through the shared policy, and a circuit breaker.

`agents/` holds discovery-agent implementations: `ScriptedAgent` (offline),
`CliAgent` (external coding-agent CLI), `ToolAgent` (native tool calling).

### 5. Context and sessions (`src/context/`, `src/session/`)

`loadMemory` reads project memory files into the system prompt. `compact`
summarizes the old prefix when the projected context nears the window and
persists a boundary the projection can honour.

`SessionStore` is an append-only JSONL tree. `projection()` rebuilds the
message list sent to the model, folding compactions and repairing dangling
tool-call/tool-result pairs. `lifecycle.ts` adds clone/fork/resume/rename/delete.

### 6. Workspace (`src/workspace/`)

`GitWorkspace` initializes the repository, tags the initial program as `root`,
creates isolated worktrees per attempt and commits each attempt's snapshot.
`diff.ts` summarizes a workspace diff. `snapshot.ts` records per-turn refs for
rollback.

### 7. Dream core (`src/env/`, `src/score.ts`, `src/tree.ts`)

`LiveEnv` and `ReplayEnv` implement the same `ExplorationEnv`:

- `legalActions()` = `["root", ...revealed leaves]` in both.
- `legalRoots()` is a count: unrevealed root children (replay) or the plan's
  remaining width (live).
- `openedBranches()` only reports branches the policy has observed.
- `reset()` clears the observed prefix, never the recorded world.
- root-child parent deltas are measured against the baseline in both envs.

`score.ts` has one scoring formula (`computeScore`), the rho grid
(`meanScoreOverGrid`) and the beta sweep (`scoreBetaCell`, `betaSweepFromCells`).
`tree.ts` holds `TreeIndex` (immutable index over a tree snapshot) and the
observation-signal helpers.

### 8. Policies (`src/policies/`)

`compilePolicy` bundles a policy source with esbuild. `runPolicyInSandbox`
replays it in a child process with a timeout, heap cap, hardened Node flags
and a scrubbed environment. `sandboxRunner.ts` is the child entry point.

The resolved `GridPlan` reaches the policy through its constructor
(`config.plan`) in live, offline, beta sweeps and holdout, so a plan bounds
`solve()` even in a sandbox that never calls `planGrid`.

`variants/fixed.ts` is the import-free seed policy; `fixedParallelRefine.ts`
is its typed twin, and `test/policies-parity.test.ts` pins them together.

### 9. Loop (`src/loop/`)

`online.ts` runs one rollout. `offline.ts` evaluates the current policy and
each revision on every history tree, runs the beta sweep, ranks versions by
`pareto.reward` (or the rho-grid mean), and selects the best.

`dream.ts` is the outer loop:

```
for round in startRound..rounds:
    choose beta (cross-cycle rule over live manifests + sweep)
    plan grid (policy.planGrid, clamped; fallback on failure)
    online rollout under the plan
    write live manifest
    offline replay under the same plan
    select π_{t+1}
```

It resumes at the round boundary from `state.json` plus the archived trees and
manifests, holds an exclusive lock on the run root, and logs round
transitions with a correlation context.

## Data flow of one round

1. **Plan.** The policy instance is asked for a `GridPlan`. It is clamped to
   the hard caps. The plan is handed to the driving policy's constructor.
2. **Online.** `LiveEnv` opens up to `branchCount` branches and refines each up
   to `refineCount` times, calling the agent and evaluator per probe. Every
   attempt is a git worktree committed to a snapshot ref and recorded as a
   `DiscoveryNode`.
3. **Manifest.** The cycle's planned vs effective grid, probes, rounds, best
   score and beta are written to `reports/tNNNN-live_cycle_manifest.json` and
   `reports/_current`.
4. **Offline.** Each policy version is replayed in the sandbox on every
   recorded tree, at every beta in the sweep. Each `(tree, beta)` produces a
   `ReplayReport`; each beta produces a sweep cell; the sweep is ranked by
   `pareto.reward = auc − λ·parallel_penalty`.
5. **Revise.** The developer receives the reports, the real trees, the score
   config and prior feedback, and returns new policy source.
6. **Select.** The version with the best mean score wins; ties keep the
   incumbent. The winner is compiled and deployed next round.
7. **Persist.** Trees, versions, reports, sweeps, feedback and `state.json` are
   written under `runs/<runId>/`.

## Invariants worth knowing

- **Determinism in replay.** The same policy on the same tree produces the
  same batches and scores. No wall clock, randomness or network in `solve()`.
- **Prefix-only observation.** A policy may not read unrevealed scores.
  `bestSoFar`/`budgetSpent` are bookkeeping only.
- **Success semantics.** `error === null && failClass === "ok"` is a successful
  evaluation even when `valid` is false.
- **Plan is a hard bound.** Neither live nor replay may exceed the effective
  plan's width or depth.
- **Single writer.** One run per run root at a time, enforced by `RunLock`.
- **No unredacted secrets on disk.** Session, transcript, report, manifest and
  log writes pass through `redact`/`redactValue`.

# dream-harness

A TypeScript coding-agent harness built around a **small set of sharp tools**
(read, grep, glob, edit, apply_patch, write, bash), with exact-match edits,
parallel tool calls, automatic compaction, project memory, tiered permissions,
verification hooks, isolated git worktrees, per-turn snapshots, secret
redaction, budgets and resumable JSONL sessions.

On top of that foundation it implements **Dream-RSI**: agent-driven discovery
loops are recorded as trees, replayed deterministically as "dreams" to score and
rewrite candidate *exploration policies*, and the improved policy is redeployed
online.

```
 ┌──────────────┐   tree T_t   ┌───────────────┐   reports   ┌──────────────────┐
 │ online       │ ───────────► │ replay every  │ ──────────► │ policy developer │
 │ rollout π_t  │              │ tree in H_t   │ ◄────────── │ writes π'        │
 └──────▲───────┘              └───────────────┘             └────────┬─────────┘
        │                                                            │
        └──────────── selected π_{t+1} = argmax mean V ◄─────────────┘
```

Only the exploration-policy code changes between rounds. The discovery agent,
the evaluator, and the task stay fixed.

## Quick start

Requirements: Node 20+ (pinned in `.nvmrc`), pnpm 9+, `git` on `PATH`, and
Python 3 for the bundled toy evaluator.

```bash
pnpm install
pnpm check          # typecheck + lint + test
pnpm build          # bundle dist/cli.js (gitignored; required for `bin`)
node dist/cli.js --help
```

`pnpm dev <args>` runs the CLI from source with `tsx`; `dist/cli.js` is the
published entry point.

Non-interactive runs:

```bash
pnpm dev fixed --rounds 3 --workers 3 --round-limit 6
pnpm dev dream --rounds 3 --revisions 2 --workers 3 --round-limit 6 --holdout-last
pnpm dev report
```

Chat with the native tool agent (needs an OpenAI-compatible endpoint):

```bash
export DREAM_BASE_URL=https://api.example.com/v1/chat/completions
export DREAM_API_KEY=...
export DREAM_AGENT_MODEL=deepseek-chat
pnpm dev chat "add a test for the parser and run it"
```

Configuration is **flags + environment only** — there is no config file.
Precedence is flag > env > default. See `docs/cli.md` for every flag and
`docs/operations.md` for logging, resume, budgets and cleanup.

## Documentation

| Document | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | layers, the loop, data flow, invariants |
| [docs/cli.md](docs/cli.md) | full command and flag reference |
| [docs/policies.md](docs/policies.md) | tutorial: write and review a policy |
| [docs/operations.md](docs/operations.md) | logging, run state, resume, budgets, troubleshooting |
| [docs/security.md](docs/security.md) | trust model and what is *not* protected |
| [docs/paper.md](docs/paper.md) | paper requirement → implementation → test |
| [CONTRIBUTING.md](CONTRIBUTING.md) | setup, gates, persisted-format rules |
| [SECURITY.md](SECURITY.md) | vulnerability reporting |
| [CHANGELOG.md](CHANGELOG.md) | release history |

## What's in the box

**Tools.** `read` (binary-aware, BOM/UTF-16, notebook rendering),
`grep`/`glob`, `edit` (exact-match, stale-file guard), `apply_patch` (atomic
multi-file), `write` (read-before-write), `bash` (persistent or one-shot,
process-group kills), `page`, `fetch` (allowlist re-checked per redirect).
Read-only calls run in parallel; mutating calls run sequentially and trigger
verification hooks.

**Safety.** Tiered `allow`/`ask`/`deny` permissions (fail-closed), symlink-aware
path resolution, an allowlisted environment for every child process (no
provider credentials), secret redaction at every persistence and logging
boundary, and per-turn git snapshots for rollback.

**Context.** Project memory, automatic compaction with a persisted boundary,
append-only JSONL session tree (clone/fork/resume/rename/delete), sub-agents,
skills, and a minimal MCP client.

**Reliability.** Jittered retry with a circuit breaker, hard token/wall/USD/
tool-call budgets, loop detection at the executor and loop level, resumable
Dream runs at the round boundary, and an exclusive cross-process run lock.

**Dream-RSI.** `LiveEnv`/`ReplayEnv` over one decision interface, one scoring
formula, the rho grid, the beta sweep ranked by `pareto.reward`, cross-cycle
default-beta selection, next-cycle grid planning, and a process-isolated policy
sandbox.

## The Dream-RSI loop

**Discovery tree.** `root` is the initial workspace, scored once as
`baselineScore`. Every other node resumes its parent's git snapshot and records
one attempt; a child of `root` opens a branch, a child of a node refines it.

**Decision interface (`ExplorationEnv`).** A policy sees `baselineScore`,
`maxParallelism`, `roundsRemaining`, `done`, `reset()`, `observed()`,
`legalActions()`, `legalRoots()`, `openedBranches()`, `meta(id)`,
`probeBatch(ids)` and `priorHistory()`. `bestSoFar` and `budgetSpent` are
bookkeeping only. `reset()` clears the *observed prefix*, never the recorded
world. Root-child deltas are measured against the baseline in both live and
replay.

`Observation` carries `nValid`/`nTotal`/`tags` and the paper's signals
(`branchPromising`, `branchFailedHard`, `improvedVsParent`,
`improvedVsBaseline`). Success semantics follow the paper: `error === null` and
`failClass === "ok"` is a successful evaluation even when `valid` is false.

**Beta sweep (`pareto.reward`).** Offline evaluation sweeps one scalar `beta`
through the policy's schedule and ranks the curve:

```
pareto.reward = pareto.auc − lambda · parallel_penalty
```

`parallel_penalty` divides by the world's `W = maxParallelism`, so a serial
policy ≈ 1 and full batches ≈ 1/W. Each round archives
`reports/tNNNN-<policy>-beta_sweep.json`; a flat curve is flagged `DEGENERATE`.

**Live manifests and default beta.** Each cycle writes
`reports/tNNNN-live_cycle_manifest.json` (plus `_current`) with the planned and
effective grid, probes, rounds, best score, baseline and baked-in beta. Later
cycles apply the paper's cross-cycle rule over the last 2–3 manifests and the
matching sweep.

**Grid planning.** Before each rollout the policy may implement
`planGrid(context) -> GridPlan`. The plan is clamped to the hard caps
(`--max-branches`, `--max-refines`) and passed to the running policy as
`config.plan` in **both** live and replay, where it is a hard bound on width and
refine depth.

**Replay score** for policy `m` on tree `i` — one formula, one place
(`src/score.ts` `computeScore`):

```
V = best − β1·N + β2·N / max(1, k)
```

`best` = best revealed normalized score (baseline if none), `N` = revealed
non-root nodes, `k` = rounds used. The rho budget terms and the lambda width
penalty are **opt-in**; omitting `--rho`/`--lambda` reproduces this objective
bit-for-bit.

**Outer loop** (`dream`): online rollout with π_t → offline replay on every tree
→ developer rewrites the policy → select the best mean `V` (ties keep π_t) →
redeploy. `--holdout-last` excludes the newest tree from selection and reports
its score as an overfitting check. `fixed` runs the same loop with a frozen
policy. Runs resume at the round boundary by default (`--no-resume` to start
over).

## Task contract

```
my-task/
  init/            # initial workspace, copied into the root commit
  evaluator/
    evaluate.py    # must live OUTSIDE the workspace
```

- `--init-dir` points at `init/`.
- `--evaluator` is a command with `{workspace}` substituted. It accepts a
  quoted string (`python3 "/opt/my tools/eval.py" {workspace}`) or a JSON argv
  array, and is executed without a shell.
- The evaluator prints **one JSON line**:

```json
{"score": 1.25, "valid": true, "failClass": "ok", "error": null, "diagnostics": {}}
```

The last non-empty stdout line is parsed; a timeout kills the whole process
group. The evaluator directory is never copied into any workspace, and the
evaluator runs with a scrubbed child environment.

## CLI

```
dream-harness dream|fixed [options]   run the loop
dream-harness chat  <message>         native tool-agent chat
dream-harness report [--json]         compare runs
dream-harness sessions [--json]       list persisted sessions
dream-harness session <id> [--json]   inspect a session
dream-harness compact <id>            summarize a session
dream-harness checkpoint --label L    git checkpoint
dream-harness worktree <name>         isolated git worktree
```

Key options: `--rounds`, `--revisions`, `--workers`, `--round-limit`,
`--beta1`, `--beta2`, `--rho`, `--lambda`, `--grid`, `--beta-grid`,
`--pareto-lambda`, `--initial-beta`, `--max-branches`, `--max-refines`,
`--normalize`, `--holdout-last`, `--no-resume`, `--max-tokens`,
`--max-wall-ms`, `--max-usd`, `--max-tool-calls`, `--log-level`,
`--log-format`, `--agent scripted|cli|deepseek|tool`, `--developer fake|cli`,
`--verify "cmd"`, `--permission allow|ask|deny`, `--model`, `--base-url`,
`--api-key`, `--context-window`, `--max-turns`. The full list is in
[docs/cli.md](docs/cli.md).

## Policy loading and safety

Policy code is untrusted. It is compiled with esbuild; each replay runs in a
**separate child process** with:

- a wall-clock timeout (the process group is `SIGKILL`ed),
- a V8 heap cap (`--max-old-space-size`),
- an environment allowlist — no API keys, and `NODE_OPTIONS` is never
  forwarded, so no `--require`/`--inspect` preload can be injected,
- hardened Node flags (`--frozen-intrinsics`, `--disable-proto=throw`,
  `--no-addons`) so a policy cannot tamper with intrinsics, mutate
  `__proto__`, or load native addons.

A crash, timeout, exception, or illegal batch scores `-Infinity` on that tree
and the reason is fed back to the developer. These guarantees are pinned by
`test/sandbox.test.ts`.

## Layout

```
src/
  types/                   shared interfaces (env, tools, chat, session)
  util/                    logger, redaction, child env, argv, budgets,
                           retry, schema, integrity, lock, atomic, stream
  tools/                   read, grep, glob, edit, apply_patch, write, bash,
                           page, fetch; permissions, truncation, hooks, executor
  agent/                   loop, OpenAI-compatible provider, verification
  context/                 compaction, project memory
  session/                 append-only JSONL tree; lifecycle
  workspace/               git, snapshots, diff
  env/                     LiveEnv + ReplayEnv
  score.ts, tree.ts, evaluator.ts
  policies/                loader, sandbox, variants
  loop/                    online, offline, dream, manifest
  runs/                    run store + comparison report
  cli.ts                   all commands
docs/                      architecture, CLI, policies, operations, security
prompts/policy-developer.md
examples/                  toy-task, fast-sum, factor-arena, self-improve
test/                      vitest suites + fuzz + CLI end-to-end
```

## Gates

```bash
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint . --max-warnings 0
pnpm format:check     # prettier --check
pnpm test             # vitest
pnpm test:coverage    # vitest + v8 coverage thresholds
pnpm test:cli         # end-to-end CLI as a subprocess (needs pnpm build)
pnpm check            # typecheck + lint + test
```

CI (`.github/workflows/ci.yml`) runs the full set on Node 20 and 22, builds,
runs the CLI smoke test and end-to-end checks, and audits dependencies.

## Known limits

- The sandbox is a **process boundary**, not a security sandbox. It enforces a
  timeout, heap cap, environment allowlist and hardened Node flags, but it does
  **not** restrict filesystem or network access. Use a container / VM for
  hostile code. See [docs/security.md](docs/security.md).
- Memory limits are V8 heap caps, not cgroups.
- Live probing is sequential at the git level within a batch; agent/evaluator
  work in a batch runs concurrently.
- The bundled example tasks are synthetic; use them to compare policies and
  costs, not as absolute numbers.

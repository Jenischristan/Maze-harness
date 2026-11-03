# Operations

How to run, observe, resume and clean up `dream-harness`.

## Requirements

- Node 20+ (pinned in `.nvmrc`), pnpm 9+
- `git` on `PATH`
- Python 3 for the bundled example evaluators

## Install and build

```bash
pnpm install
pnpm build            # typecheck + bundle to dist/cli.js
node dist/cli.js --help
```

`pnpm dev <args>` runs from source with `tsx`; `dist/cli.js` is the published
entry point and is not committed.

## Environment

| Variable               | Purpose                       | Default                                     |
| ---------------------- | ----------------------------- | ------------------------------------------- |
| `DREAM_BASE_URL`       | OpenAI-compatible endpoint    | `http://127.0.0.1:8788/v1/chat/completions` |
| `DREAM_API_KEY`        | provider key (never logged)   | —                                           |
| `DREAM_AGENT_MODEL`    | default model id              | `deepseek-chat`                             |
| `DREAM_CONTEXT_WINDOW` | context window in tokens      | `128000`                                    |
| `DREAM_LOG_LEVEL`      | `debug`/`info`/`warn`/`error` | `info`                                      |
| `DREAM_LOG_FORMAT`     | `text` or `json`              | `text`                                      |

Precedence is **flag > environment > default**. There is no config file.

## Logging

Logs go to **stderr** in one of two shapes so stdout stays parseable for
`--json` commands.

Text (default):

```
2026-11-03T04:20:42.271Z INFO loop.dream round started mode=dream policyId=fixed round=1 runId=e2e
```

JSON (`DREAM_LOG_FORMAT=json`): one object per line with `level`, `scope`,
`message`, `time` and correlation fields (`runId`, `round`, `treeIndex`).
`DREAM_LOG_LEVEL=debug` adds per-probe detail.

Log fields whose name looks like a credential are replaced with `[REDACTED]`,
and known secret values are scrubbed from message text.

## Run state layout

```
runs/
  .dream.lock                     exclusive run lock (removed on exit)
  <runId>/
    state.json                    pointer: last completed round
    trees/tree-NNNN.json          recorded discovery trees
    policies/tNNNN-<id>.ts/.json  evaluated policy versions
    reports/
      tNNNN-live_cycle_manifest.json
      reports/_current
      tNNNN-<id>-beta_sweep.json
      tNNNN-<id>.json             replay reports
      tNNNN-feedback.md
    policies/build/               esbuild output (safe to delete)
  _sessions/                      agent session JSONL
  _transcripts/                   per-attempt transcripts (redacted)
```

`runs/` is generated. Do not edit it; delete it to start clean.

## Resuming an interrupted run

The Dream loop writes `state.json` after each completed round. Re-running with
the same `--run-id` continues from the next round instead of restarting:

```bash
pnpm dev dream --run-id dream-abc123 --rounds 5
# interrupted at round 3
pnpm dev dream --run-id dream-abc123 --rounds 5   # resumes at round 4
```

Resume validates the archived trees against the recorded round; a mismatch is
logged and the incomplete round is re-run. Pass `resume: false` from the API (or
delete `state.json`) to start over.

## Concurrency

One run per run root at a time. A second process gets a clear error naming the
holder's PID and host. A lock whose owner is gone, or that is older than six
hours, is reclaimed automatically with a warning.

## Budgets

`--max-turns` bounds turns. The API additionally accepts `maxTokens`,
`maxWallMs`, `maxUsd` and `maxToolCalls`; exceeding any of them stops the loop
with `stopReason: "budget"` (the turn limit keeps reporting `max-turns`). The
USD budget uses the price table in `src/cost.ts` and is an estimate.

## Cleanup

```bash
rm -rf runs/          # all runs, sessions, transcripts
rm -rf coverage/      # coverage output
rm -rf dist/          # build output
```

Stale git worktrees under `runs/_repo/worktrees/` are pruned on the next
`init()` and by `GitWorkspace.pruneWorktrees()`.

## Troubleshooting

| Symptom                         | Likely cause                                         | Fix                                                            |
| ------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `run lock held by pid …`        | another run in the same root                         | wait, or stop that process; a dead lock is reclaimed           |
| every replay scores `-Infinity` | policy throws, times out, or issues an illegal batch | read `reports/tNNNN-feedback.md`; the reason is the first line |
| `policy … failed to compile`    | policy source does not typecheck/bundle              | fix the source; the esbuild error is in the thrown message     |
| `provider 401`                  | missing/incorrect `DREAM_API_KEY`                    | set the key; it is not read from a file                        |
| `circuit breaker open`          | repeated transient provider failures                 | the endpoint is unhealthy; retry after the cooldown            |
| `budget exceeded: …`            | a configured limit was reached                       | raise the limit or reduce the task scope                       |
| binary read refused             | the path is an image/archive/etc.                    | use a dedicated tool or inspect it outside the harness         |

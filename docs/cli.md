# CLI reference

Generated from the commander definitions in `src/cli.ts`. Run
`node dist/cli.js <command> --help` for the authoritative, always-current text.

```
Usage: maze-harness [options] [command]

Commands:
  dream [options]            run the Dream-RSI loop
  fixed [options]            run with a frozen policy
  chat [options] [words...]  chat with the native tool agent in the current directory
  report [options]           compare fixed vs dream runs
  sessions [options]         list persisted agent sessions (newest first)
  session <id> [options]     inspect or export a persisted session
  compact <id> [options]     summarize a persisted session's history
  checkpoint [options]       create a git checkpoint of the current directory
  worktree <name> [options]  create an isolated git worktree for a task
```

## `dream` / `fixed`

Both run the same loop; `fixed` freezes the policy instead of revising it.

### Loop shape

| Flag                | Meaning                                                      | Default   |
| ------------------- | ------------------------------------------------------------ | --------- |
| `--run-id <id>`     | run identifier; reusing it resumes the run                   | random    |
| `--rounds <n>`      | outer rounds `T`                                             | `3`       |
| `--revisions <m>`   | policy revisions per round `M`                               | `2`       |
| `--workers <w>`     | max parallelism `W`                                          | `3`       |
| `--round-limit <k>` | rounds per online rollout `K1`                               | `6`       |
| `--holdout-last`    | exclude the newest tree from selection                       | off       |
| `--no-resume`       | start over instead of continuing at the last completed round | resume on |

### Replay objective

| Flag                 | Meaning                                      | Default              |
| -------------------- | -------------------------------------------- | -------------------- |
| `--beta1 <n>`        | probe penalty `β1`                           | `0.002`              |
| `--beta2 <n>`        | parallelism bonus `β2`                       | `0.01`               |
| `--rho <n>`          | budget preference in `[0,1]` (opt-in)        | grid-selected        |
| `--lambda <n>`       | width penalty over `Σ(batch−1)`              | `0`                  |
| `--grid <list>`      | rho grid for selection when the sweep is off | `0,0.25,0.5,0.75,1`  |
| `--normalize <mode>` | `relativeToBaseline` or `none`               | `relativeToBaseline` |

### Beta sweep and grid planning

| Flag                  | Meaning                                                | Default               |
| --------------------- | ------------------------------------------------------ | --------------------- |
| `--beta-grid <list>`  | evaluation-time beta sweep; `off` disables             | `0,0.2,0.4,0.6,0.8,1` |
| `--pareto-lambda <n>` | `λ` in `pareto.reward = auc − λ·parallel_penalty`      | `0`                   |
| `--initial-beta <n>`  | baked-in beta for the first live cycle; `off` disables | policy default        |
| `--max-branches <n>`  | hard cap on planned grid width                         | `--workers`           |
| `--max-refines <n>`   | hard cap on planned refinements per branch             | `--round-limit`       |

### Task and workspace

| Flag                       | Meaning                                                                  | Default                  |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------ |
| `--init-dir <dir>`         | initial workspace                                                        | `examples/toy-task/init` |
| `--evaluator <cmd>`        | evaluator command; `{workspace}` substituted; quoted string or JSON argv | toy evaluator            |
| `--evaluator-timeout <ms>` | evaluator timeout                                                        | `20000`                  |
| `--agent-timeout <ms>`     | discovery-agent timeout                                                  | `20000`                  |
| `--repo <dir>`             | git workspace repo                                                       | `runs/_repo`             |
| `--runs-dir <dir>`         | run state                                                                | `runs`                   |
| `--task <text>`            | task prompt for the discovery agent                                      | generic                  |
| `--verify <cmd>`           | verification command after edits (repeatable; `;;` separates)            | none                     |

### Agents and developers

| Flag                             | Meaning                                       | Default                       |
| -------------------------------- | --------------------------------------------- | ----------------------------- |
| `--agent <mode>`                 | `scripted`, `cli`, `deepseek`, `tool`         | `scripted`                    |
| `--seed <n>`                     | scripted-agent seed                           | `1`                           |
| `--agent-command <cmd>`          | coding-agent CLI command (`--agent cli`)      | —                             |
| `--agent-prompt-mode <mode>`     | `stdin` or `arg`                              | `stdin`                       |
| `--developer <mode>`             | `fake` or `cli`                               | `fake`                        |
| `--developer-command <cmd>`      | policy-developer CLI command                  | —                             |
| `--developer-prompt-mode <mode>` | `stdin` or `arg`                              | `stdin`                       |
| `--developer-prompt <path>`      | developer prompt file                         | `prompts/policy-developer.md` |
| `--permission <mode>`            | `allow`, `ask`, `deny` for unmatched commands | `allow`                       |

### Policy sandbox

| Flag                     | Meaning                        | Default |
| ------------------------ | ------------------------------ | ------- |
| `--sandbox-timeout <ms>` | per policy-tree replay timeout | `5000`  |
| `--sandbox-memory <mb>`  | per replay child heap cap      | `256`   |

### Budgets

All optional; omitted means no cap of that kind.

| Flag                   | Meaning                                    |
| ---------------------- | ------------------------------------------ |
| `--max-turns <n>`      | max agent turns per attempt (default `40`) |
| `--max-tokens <n>`     | hard token budget per agent task           |
| `--max-wall-ms <n>`    | hard wall-clock budget in ms               |
| `--max-usd <n>`        | hard estimated USD budget                  |
| `--max-tool-calls <n>` | hard tool-call budget                      |

### Provider and logging

| Flag                   | Meaning                          | Default                                 |
| ---------------------- | -------------------------------- | --------------------------------------- |
| `--model <name>`       | model for the tool agent / chat  | `$DREAM_AGENT_MODEL` or `deepseek-chat` |
| `--base-url <url>`     | OpenAI-compatible endpoint       | `$DREAM_BASE_URL` or localhost          |
| `--api-key <key>`      | provider key                     | `$DREAM_API_KEY`                        |
| `--context-window <n>` | context window in tokens         | `$DREAM_CONTEXT_WINDOW` or `128000`     |
| `--log-level <level>`  | `debug`, `info`, `warn`, `error` | `$DREAM_LOG_LEVEL` or `info`            |
| `--log-format <fmt>`   | `text` or `json`                 | `$DREAM_LOG_FORMAT` or `text`           |

## `chat`

One non-interactive turn with the native tool agent.

| Flag                                                                    | Meaning                              | Default     |
| ----------------------------------------------------------------------- | ------------------------------------ | ----------- |
| `--message <text>`                                                      | message (or pass words positionally) | —           |
| `--model`, `--base-url`, `--api-key`, `--context-window`, `--max-turns` | as above                             | as above    |
| `--runs-dir <dir>`                                                      | session directory                    | `runs`      |
| `--verify <cmd>`                                                        | verification command (repeatable)    | none        |
| `--permission <mode>`                                                   | `allow`, `ask`, `deny`               | `allow`     |
| `--max-tokens`, `--max-wall-ms`, `--max-usd`, `--max-tool-calls`        | budgets                              | no cap      |
| `--log-level`, `--log-format`                                           | logging                              | env/default |

Exit codes: `0` success, `1` error or loop, `3` budget exceeded.

## `report`

Compares fixed vs dream runs: best score against cumulative agent calls.

| Flag               | Meaning                      | Default |
| ------------------ | ---------------------------- | ------- |
| `--runs-dir <dir>` | run state                    | `runs`  |
| `--json`           | emit JSON instead of a table | off     |

## `sessions`

Lists persisted sessions, newest first. `--runs-dir <dir>`, `--json`.

## `session <id>`

Inspects one session. `--runs-dir <dir>`, `--json` (raw JSONL).

## `compact <id>`

Summarizes a session's history. `--runs-dir <dir>`, `--model <name>`,
`--base-url <url>`.

## `checkpoint`

Creates a git commit and tag of the current repository. `--repo <dir>`,
`--label <name>`.

## `worktree <name>`

Creates an isolated worktree. `--repo <dir>`, `--ref <ref>` (default `root`),
`--init-dir <dir>`.

## Environment

Precedence is **flag > environment > project config file > built-in default**.
The file is `maze.json` (also `opencode.json`, `.maze.json`, or `$MAZE_CONFIG`).

| Variable               | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `DREAM_BASE_URL`       | OpenAI-compatible endpoint               |
| `DREAM_API_KEY`        | provider key (never logged or persisted) |
| `DREAM_AGENT_MODEL`    | default model id                         |
| `DREAM_CONTEXT_WINDOW` | context window in tokens                 |
| `DREAM_LOG_LEVEL`      | `debug`/`info`/`warn`/`error`            |
| `DREAM_LOG_FORMAT`     | `text` or `json`                         |

## Command arguments with spaces

`--evaluator`, `--agent-command` and `--developer-command` accept either a
shell-like string with quotes or a JSON array:

```bash
--evaluator 'python3 "/opt/my tools/eval.py" {workspace}'
--evaluator '["python3","/opt/my tools/eval.py","{workspace}"]'
```

They are executed without a shell; use `sh -c '…'` explicitly when you need
one.

# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Child environment scrubbing** now applies the denylist to caller-supplied
  extras, not just to the parent environment. Previously a task could pass
  `DREAM_API_KEY` (or any other provider secret) to a hook, MCP server or agent
  CLI through its `env` option. The internal `DREAM_CHILD` marker is exempt.
- **`parseDuckDuckGo`** never captured result snippets, because a lazy
  wildcard consumed the snippet anchor before the optional group could match.
  Every `websearch` result had an empty snippet.
- **`McpClient.connect`** crashed the host process with an uncaught `ENOENT`
  when a configured server binary was missing; it also reported the failure as
  a misleading `initialize timed out`. The spawn `error` event is now handled
  and rejects pending requests immediately.
- **`multiedit` was not atomic.** `edit` ignored `dryRun` and wrote to disk, so
  a failing second file left the first one modified. `edit` now honours
  `dryRun`, and `multiedit` stages all writes before committing (and rejects
  the same file listed twice).
- **`apply_patch`** rejected the documented `***NEW***` separator, so every
  update hunk failed to parse, and `*** Delete File:` truncated the file to
  zero bytes instead of deleting it.
- **`lsp`** threw `ERR_AMBIGUOUS_MODULE_SYNTAX` on every call (`require()` in
  an ESM module) and attributed other files' diagnostics to the requested path
  through a substring filter.
- **`parseSse`** dropped a final event that had no trailing blank line, which
  corrupted streamed tool-call arguments.
- **`diffWorkspace`** reported untracked files as "no changes".
- **`listSessions`** only scanned the last 256 KB, under-reporting message
  counts and usage for long sessions.
- **JSONL integrity checks** flagged any record containing an `undefined`
  field as tampered after a JSON round-trip.
- **`FileGoalStore.remove("")`** silently deleted the first goal.
- **Permission deny list** could be bypassed with an absolute path
  (`/usr/bin/sudo` was allowed while `sudo` was denied).
- **Fuzzy edit matching** replaced only a prefix of the intended block for the
  `line-trimmed` and `indentation` strategies.
- **`schema` migration** silently stamped the target version when no upcaster
  existed.
- **Forking a session** at an invalid point left an orphan session file.
- **factor-arena evaluator** graded four hard cases as correct regardless of
  output (`expected = None`) and had a wrong reference value for `gap_5e6`.

### Added

- System tests that run the bundled toy-task, fast-sum, factor-arena and
  self-improve evaluators as child processes and assert the one-JSON-line
  contract, including the failure and offline paths.
- Integration tests for the full chat path against a local SSE server (streaming,
  tool-call round-trip, budget stop, provider error exit code).
- Tests for the discovery agents (`runCli`, `CliAgent`, `ScriptedAgent`,
  `ToolAgent`), MCP handshake/tool-call round-trip, prompt assembly, skills and
  workspace snapshots/materialisation. Line coverage rose from 66% to ~78%.

## [1.0.0] - 2026-11-03

First production-quality release. The Dream-RSI loop, replay objective,
grid planning, beta sweep and policy sandbox implement the paper's method.
This release hardens the harness around it.

### Added

- **Structured logging** (`src/util/logger.ts`): leveled records with a stable
  text format or NDJSON (`DREAM_LOG_FORMAT=json`), correlation context, and
  secret redaction at the sink. Configure with `DREAM_LOG_LEVEL`.
- **Secret redaction** (`src/util/redact.ts`): sessions, transcripts, run
  stores, tool output, hook output, provider errors and logs are scrubbed of
  bearer tokens, provider key shapes, PEM keys, and known secret env values.
- **Child environment scrubbing** (`src/util/env.ts`): every spawned process
  (discovery agent CLI, evaluator, verification hook, MCP server, git, bash)
  gets an allowlisted environment. Provider credentials and loader hooks
  (`NODE_OPTIONS`, `LD_PRELOAD`, …) are never inherited.
- **Safe command parsing** (`src/util/args.ts`): `--evaluator`, `--agent-command`
  and `--developer-command` accept shell-like quoting or a JSON argv array
  instead of `split(" ")`, so paths with spaces work.
- **Budgets** (`src/util/limits.ts`): token, wall-clock, USD and tool-call
  limits in addition to turns. Exceeding one stops the agent loop cleanly.
- **Retry policy and circuit breaker** (`src/util/retry.ts`): configurable,
  jittered backoff shared by provider calls; a dead endpoint fails fast.
- **Per-turn snapshots** (`src/workspace/snapshot.ts`) and turn-level rollback
  in the agent loop; **`apply_patch`** (`src/tools/patch.ts`) for atomic
  multi-file edits.
- **Schema versioning and migrations** (`src/util/schema.ts`), **JSONL integrity
  checks** (`src/util/integrity.ts`) and a **cross-process run lock**
  (`src/util/lock.ts`).
- **Round-boundary resume** for the Dream loop (`resume`, on by default).
- **Binary/notebook-aware `read`**: refuses binary files, decodes BOM/UTF-16,
  renders `.ipynb` cells.
- Coverage reporting with thresholds, ESLint + Prettier, CI workflow, docs/
  (architecture, CLI reference, policy tutorial, security, operations),
  CONTRIBUTING, SECURITY.md, LICENSE, CHANGELOG.

### Fixed

- Developer feedback used a fabricated tree baseline (`report.best`) and a
  hard-coded score config, so feedback disagreed with selection.
- `LiveEnv.reset()` erased the recorded discovery tree.
- `ReplayEnv` root-child parent deltas depended on a never-assigned field.
- A policy's `planGrid` output never bounded replay; the plan now reaches the
  policy through its constructor in live, offline, sweeps and holdout.
- Provider retries were unbounded, unjittered and had no breaker.

### Changed

- `package.json` renamed to `maze-harness`, version `1.0.0`, with `files`,
  `packageManager`, lint/format/coverage/docs scripts.
- Live manifest records carry `schema` instead of `version`.

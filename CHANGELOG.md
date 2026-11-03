# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

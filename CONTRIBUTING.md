# Contributing

Thanks for helping improve `dream-harness`. This document covers the
expectations for changes; `docs/architecture.md` explains how the pieces fit
together and `docs/cli.md` is the command reference.

## Setup

Requirements: Node 20+ (the pinned version is in `.nvmrc`), pnpm 9+.

```bash
pnpm install
pnpm check       # typecheck + lint + tests
```

`pnpm install` also installs the dev tools used by the gates below.

## The gates

Every change must keep all of these green:

| Command              | What it does                                                     |
| -------------------- | ---------------------------------------------------------------- |
| `pnpm typecheck`     | `tsc --noEmit` under `strict` + `noUncheckedIndexedAccess`       |
| `pnpm lint`          | ESLint (flat config)                                             |
| `pnpm format:check`  | Prettier check                                                   |
| `pnpm test`          | Vitest unit + integration + fuzz suites                          |
| `pnpm test:coverage` | Vitest with v8 coverage and the thresholds in `vitest.config.ts` |
| `pnpm test:cli`      | End-to-end CLI as a subprocess                                   |
| `pnpm build`         | Typecheck + esbuild bundle into `dist/`                          |

`pnpm check` runs typecheck + lint + test. CI (`.github/workflows/ci.yml`)
runs the full set on Node 20 and 22, then builds and runs the CLI smoke test.

## Running one test file

```bash
pnpm vitest run test/score.test.ts        # one file
pnpm vitest run -t "beta sweep"           # tests whose name matches
pnpm vitest watch                          # watch mode
```

## Style

- TypeScript strict mode; no `any`, no `@ts-ignore` without a comment.
- Prefer `type` imports (`import type { X } from ...`).
- Keep functions small and named for what they do, not how.
- Comments explain _why_ a non-obvious choice was made, not what the code does.
- Every bug fix gets a regression test that fails before the fix. Name it after
  the invariant, not the function.

## Changing persisted formats

Sessions, trees, run state and live manifests are versioned (`src/util/schema.ts`).
When you change one:

1. Bump `CURRENT_SCHEMA`.
2. Register an upcaster for the previous version (`registerUpcaster`).
3. Add a fixture test that loads the old shape and asserts the upgraded one.
4. Never weaken a reader to accept a _newer_ schema; fail with a clear error.

## Changing the exploration interface

`ExplorationEnv`, `Observation`, `CellMeta`, `GridPlan` and `GridPlanningContext`
are the contract the paper defines and third-party policies are written
against. Adding an optional member is fine; changing or removing one is a
breaking change and needs a CHANGELOG entry.

## Security-sensitive areas

Changes under `src/tools/` (permissions, path resolution, bash, fetch),
`src/policies/sandbox.ts`, `src/util/env.ts` and `src/util/redact.ts` are
security-sensitive. Add a test that proves the property you are preserving,
and update `docs/security.md` if the trust model changes.

## Commits and PRs

- One logical change per commit; the message says what changed and why.
- Reference the issue it closes.
- Describe how you verified the change (commands run, tests added).

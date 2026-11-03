# Project memory

Loaded into every agent session. Keep it short and concrete.

## Build & test commands

- `pnpm dev <cmd>` — run the CLI from source (`tsx src/cli.ts`)
- `pnpm build` — typecheck + bundle to `dist/cli.js` (dist/ is gitignored)
- `pnpm typecheck` — type-check without emitting
- `pnpm lint` — ESLint (flat config)
- `pnpm format:check` — Prettier check
- `pnpm test` — run the whole Vitest suite
- `pnpm vitest run test/score.test.ts` — run a single test file
- `pnpm vitest run -t "beta sweep"` — run tests whose name matches
- `pnpm test:coverage` — tests with v8 coverage and thresholds
- `pnpm test:cli` — end-to-end CLI as a subprocess
- `pnpm check` — typecheck + lint + test (what CI runs)

## Environment (chat / tool agent need a provider)

- `DREAM_BASE_URL` — OpenAI-compatible endpoint
- `DREAM_API_KEY` — provider key (never logged or persisted)
- `DREAM_AGENT_MODEL` — default model id
- `DREAM_CONTEXT_WINDOW` — context window in tokens
- `DREAM_LOG_LEVEL` / `DREAM_LOG_FORMAT` — `debug|info|warn|error` / `text|json`

Precedence is flag > env > default. There is no config file.

## Conventions

- Edits must be exact-match; read a file before editing it.
- Prefer small, focused changes with a regression test.
- Persisted formats are versioned: bump `CURRENT_SCHEMA` and add an upcaster.
- `ExplorationEnv`/`Observation`/`GridPlan` are public interface; additive only.

## Gotchas

- `runs/`, `dist/`, `coverage/`, `worktrees/` are generated; do not edit them.
- The replay sandbox constructs a fresh policy per tree and never calls
  `planGrid`, so a plan must reach the policy via the constructor (`config.plan`).
- `bash`, hooks, MCP servers and the evaluator get a scrubbed child env; do not
  reach for `process.env` provider keys from inside them.

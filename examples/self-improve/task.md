# Task: improve the maze-harness

You are working inside a copy of the maze-harness repository itself. Improve the
harness. The evaluator installs dependencies, runs `pnpm typecheck`, then runs the
full test suite, and scores `passed / total`. A failing typecheck halves the score.

## What earns points

1. **Add tests that pass.** Every new passing test raises the numerator *and* the
   denominator, so the score only goes up if you also keep existing tests green.
   Look for untested behaviour in `src/` and add focused tests under `test/`.
2. **Fix real bugs.** Anything that currently fails, flakes, or is obviously wrong.
3. **Harden the tool layer** (`src/tools/`) — edit safety, truncation, permissions,
   the persistent shell.
4. **Improve the Dream-RSI loop** (`src/loop/`, `src/env/`, `src/score.ts`) — the
   replay objective, selection, holdout handling.

## Rules

- Read a file before editing it. Edits are exact-match and fail loudly.
- Do not edit `examples/self-improve/evaluator/` — it is outside the workspace.
- Keep the public CLI behaviour working: `pnpm typecheck` and `pnpm test` must pass.
- Prefer small, focused changes. Do not add dependencies.
- When finished, reply with a short summary and no tool calls.

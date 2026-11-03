# Paper to code traceability

Every requirement the paper states (Sections 3-5 and Appendices A-B) mapped to
where it lives and how it is verified. "Test" names a file under `test/`.

## Discovery tree and decision interface (Section 3)

| Requirement                                                                | Implementation                                                       | Test                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------ | ---------------------------- | ------------------------ |
| Root is the initial workspace, scored once as the baseline                 | `runDream` baseline worktree; `DiscoveryTree.baselineScore`          | `dream-audit`, `live`    |
| Each non-root node has exactly one primary parent and resumes its snapshot | `LiveEnv.prepare`/`execute`; `DiscoveryNode.parentId`                | `live`, `live-plan`      |
| Eligible nodes `A(T) = {r} ∪ leaves`                                       | `TreeIndex.leaves`; `LiveEnv.legalActions`, `ReplayEnv.legalActions` | `fix-dream`, `fuzz/core` |
| Batch `                                                                    | C                                                                    | ≤ W`                     | `validateBatch` in both envs | `fix-dream`, `fuzz/core` |
| Online: one child per selected parent per round                            | `LiveEnv.execute`                                                    | `live`                   |
| Online ends on empty batch or `K1` rounds                                  | `LiveEnv.probeBatch`, `roundsRemaining`                              | `live`, `live-plan`      |
| Replay: root reveals the earliest-created unrevealed child                 | `TreeIndex.firstUnrevealedRootChild`                                 | `core`                   |
| Replay: non-root reveals its unique recorded child                         | `TreeIndex.latestChild`                                              | `core`                   |
| Replay ends on empty batch, `K2`, or full reveal                           | `ReplayEnv.probeBatch`                                               | `core`, `fix-dream`      |
| Replay branch order follows the recorded parent-child order                | `TreeIndex` built from `seq` order                                   | `fuzz/core`              |

## Replay objective (Equation 1)

```
V = max_v s_v − β1·N + β2·N / max(1, k)
```

| Requirement                                                          | Implementation                              | Test                  |
| -------------------------------------------------------------------- | ------------------------------------------- | --------------------- |
| `best` is the best revealed score, baseline when none                | `computeScore`                              | `core`, `fix-dream`   |
| `N` is revealed non-root nodes                                       | `computeScore` (`revealedScores.length`)    | `core`                |
| `k` is completed rounds, floored at 1                                | `computeScore`                              | `core`                |
| β1/β2 coefficients                                                   | `DEFAULT_SCORE_CONFIG`, `--beta1`/`--beta2` | `core`                |
| Optional rho budget terms reproduce the classic objective when unset | `computeScore`                              | `dream-audit`, `core` |
| Optional lambda width penalty over `Σ(batch−1)`                      | `computeScore`                              | `dream-audit`         |

## Policy improvement and selection (Section 3)

| Requirement                                             | Implementation                                                     | Test                           |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------ |
| `V^m` is the mean over all history trees                | `meanScoreOverGrid`, sweep reward                                  | `core`, `fuzz/coverage`        |
| Candidate set includes the current policy               | `runOfflinePhase` evaluates the incumbent first                    | `fuzz/coverage`                |
| Select `argmax V`, ties keep the incumbent              | strict `>` selection loop                                          | `fuzz/coverage`, `dream-audit` |
| Developer sees replay trajectories and earlier feedback | `PolicyDeveloper.revise` receives reports, trees, config, feedback | `developer-feedback`           |
| Holdout excludes the newest tree from selection         | `useTrees` slice in `runDream`                                     | `dream-audit`                  |

## Beta sweep and cross-cycle beta (Appendix B.2)

| Requirement                                                | Implementation                          | Test                           |
| ---------------------------------------------------------- | --------------------------------------- | ------------------------------ |
| `pareto.reward = auc − λ·parallel_penalty`                 | `betaSweepFromCells`                    | `paper-api`                    |
| Parallel penalty uses the world's `W`, not the batch width | `scoreBetaCell`                         | `paper-api`                    |
| Degenerate sweep is flagged                                | `betaSweepFromCells`                    | `paper-api`                    |
| Sweep archived as `reports/tNNNN-<policy>-beta_sweep.json` | `runOfflinePhase`                       | `fuzz/coverage`                |
| Cross-cycle rule over the last 2-3 live manifests + sweep  | `chooseDefaultBeta`                     | `paper-api`                    |
| Moderate default `0.6` when history is thin                | `MODERATE_DEFAULT_BETA`                 | `paper-api`                    |
| One step of ~0.1, clamped to `[0,1]`                       | `BETA_STEP`, `clamp01`                  | `paper-api`                    |
| Beta fixed inside an episode                               | policy reads it once in the constructor | `paper-api`, `policies-parity` |

## Next-cycle grid planning (Appendix B.2)

| Requirement                                                                 | Implementation                                  | Test                       |
| --------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------- |
| `planGrid(context) -> GridPlan` before a live cycle                         | `planGridForRound`                              | `dream-audit`              |
| Plan always non-null; fallback derived from caps                            | `planGridForRound`                              | `dream-audit`              |
| Clamp to `1 ≤ W ≤ hardMax` and `0 ≤ R ≤ hardMax`                            | `normalizePlan`                                 | `paper-api`, `dream-audit` |
| Context carries prior planned/effective grids, probes, rounds, scores, beta | `GridPlanningContext` built from `CycleHistory` | `dream-audit`              |
| Runtime grid is a hard bound in live                                        | `LiveEnv.validateBatch`                         | `live-plan`                |
| Runtime grid is a hard bound in replay                                      | `config.plan` in constructor                    | `plan-propagation`         |

## Policy API and safety (Appendix B.2)

| Requirement                                                                                                                                      | Implementation                                          | Test                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------ |
| `reset()`, `observed()`, `legal_actions()`, `legal_roots()`, `opened_branches()`, `meta()`, `probe_batch()`, `baseline_score`, `max_parallelism` | `ExplorationEnv`                                        | `paper-api`              |
| `Observation` fields incl. `n_valid`/`n_total`                                                                                                   | `Observation`, `readValidCounts`                        | `paper-api`              |
| Observation signals: `branch_promising`, `branch_failed_hard`, `improved_vs_parent`, `improved_vs_baseline`                                      | `withBranchSignals`                                     | `paper-api`, `fuzz/core` |
| Success semantics: `error === null && failClass === "ok"`                                                                                        | `withBranchSignals`                                     | `fuzz/core`              |
| `best_so_far`/`budget_spent` are bookkeeping only                                                                                                | documented; not used by built-ins                       | `paper-api`              |
| Prefix-only: no unrevealed scores or tree structure                                                                                              | `openedBranches`/`legalRoots` reflect observations only | `fix-dream`, `fuzz/core` |
| Replay calls run in an isolated process                                                                                                          | `runPolicyInSandbox`                                    | `sandbox`                |
| Timeout, heap cap, env allowlist, hardened flags                                                                                                 | `sandbox.ts`                                            | `sandbox`                |
| Illegal batch, crash or timeout scores `-Infinity` and feeds back the reason                                                                     | `sandboxRunner`/`failedReport`                          | `sandbox`                |
| Deterministic replay of the same policy                                                                                                          | no clock/randomness in `solve`                          | `live`, `core`           |

## Task contract (Appendix A)

| Requirement                                                  | Implementation                       | Test          |
| ------------------------------------------------------------ | ------------------------------------ | ------------- |
| Evaluator prints one JSON line, last non-empty line parsed   | `CommandEvaluator`                   | `fuzz/io`     |
| Evaluator timeout kills the process group                    | `CommandEvaluator`                   | `fuzz/io`     |
| Evaluator lives outside the workspace and is never copied in | `runDream` uses the command directly | `dream-audit` |
| Score, valid, failClass, error, diagnostics                  | `EvaluatorResult`                    | `fuzz/io`     |

## Known, documented divergences

- The **rho budget preference** and the **lambda width penalty** are extensions
  layered on Equation (1); they are opt-in so the paper's objective is
  reproduced bit-for-bit when omitted (`README`, `core`).
- The live tree records one child per non-root node by construction
  (`id = <parent>.<attempt>`), so the paper's "unique recorded child" holds;
  `latestChild` picks the newest only for a hand-written tree with siblings.
- Appendix C (the discovered Lasso solver) is an output artifact and is not
  part of the harness; see `Dream-RSI/papers/DREAM_4.md`.

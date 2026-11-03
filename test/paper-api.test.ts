import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayEnv } from "../src/env/replay.js";
import { FixedParallelRefine } from "../src/policies/fixedParallelRefine.js";
import { compilePolicy } from "../src/policies/loader.js";
import { runPolicyInSandbox } from "../src/policies/sandbox.js";
import {
  BETA_SWEEP_GRID,
  betaSweepFromCells,
  DEFAULT_SCORE_CONFIG,
  scoreBetaCell
} from "../src/score.js";
import { ROOT_ID } from "../src/tree.js";
import {
  BETA_STEP,
  MODERATE_DEFAULT_BETA,
  chooseDefaultBeta,
  loadLiveManifests,
  saveLiveManifest,
  type BetaSweepPoint,
  type LiveCycleManifest
} from "../src/loop/manifest.js";
import type { ExplorationPolicy, GridPlanningContext } from "../src/types.js";
import { syntheticTree } from "./synthetic.js";

/**
 * Pins the API surface documented in the Dream-RSI paper, Appendix B.2:
 *
 *   question.reset()
 *   question.meta(cell_id) -> CellMeta
 *   question.best_so_far / question.budget_spent   (bookkeeping only)
 *   Observation.n_valid / n_total
 *   pareto.reward = pareto.auc - lambda * parallel_penalty
 *   plan_grid(context) -> GridPlan(branch_count, refine_count, reason)
 */

const W = 3;

function tree(seed: number) {
  return syntheticTree({
    seed,
    branches: W,
    refinements: 3,
    maxParallelism: W,
    roundsLimit: 6
  });
}

let tmp = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dh-paper-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("exploration env: paper API", () => {
  it("reset() returns the env to a root-only prefix and replays identically", async () => {
    const t = tree(3);
    const env = new ReplayEnv(t, { maxRounds: 6 });
    const policy = new FixedParallelRefine();
    await policy.solve(env);
    const firstBatches = env.batchesTaken();
    const firstObserved = [...env.observed().keys()].sort();
    expect(firstBatches.length).toBeGreaterThan(0);

    env.reset();
    expect(env.rounds).toBe(0);
    expect(env.observed().size).toBe(0);
    expect(env.done).toBe(false);

    await policy.solve(env);
    expect(env.batchesTaken()).toEqual(firstBatches);
    expect([...env.observed().keys()].sort()).toEqual(firstObserved);
  });

  it("meta() exposes structural fields without unrevealed scores", async () => {
    const env = new ReplayEnv(tree(4), { maxRounds: 6 });
    const rootMeta = env.meta(ROOT_ID);
    expect(rootMeta.id).toBe(ROOT_ID);
    expect(rootMeta.tags).toContain("root");

    await env.probeBatch([ROOT_ID]);
    const [first] = [...env.observed().values()];
    expect(first).toBeDefined();
    const meta = env.meta(first!.id);
    expect(meta.branch).toBe(first!.branch);
    expect(meta.attempt).toBe(first!.attempt);
    expect(meta.parentId).toBe(first!.parentId);
    expect(meta.seq).toBe(first!.seq);
    // Structural metadata must not carry a score field at all.
    expect(Object.keys(meta)).not.toContain("score");
  });

  it("bestSoFar and budgetSpent track revealed nodes", async () => {
    const env = new ReplayEnv(tree(6), { maxRounds: 6 });
    expect(env.budgetSpent).toBe(0);
    expect(env.bestSoFar).toBe(env.baselineScore);

    await env.probeBatch([ROOT_ID, ROOT_ID]);
    const scores = [...env.observed().values()]
      .map((o) => o.score)
      .filter((s): s is number => s !== null);
    expect(env.budgetSpent).toBe(env.observed().size);
    if (scores.length > 0) {
      expect(env.bestSoFar).toBe(Math.max(...scores));
    }
  });

  it("observations carry nValid/nTotal/tags fields", async () => {
    const env = new ReplayEnv(tree(8), { maxRounds: 6 });
    await env.probeBatch([ROOT_ID]);
    for (const obs of env.observed().values()) {
      expect(obs).toHaveProperty("nValid");
      expect(obs).toHaveProperty("nTotal");
      expect(Array.isArray(obs.tags)).toBe(true);
    }
  });
});

describe("beta sweep and pareto.reward", () => {
  it("scoreBetaCell reports attainment, probes and the parallel penalty", async () => {
    const t = tree(2);
    const env = new ReplayEnv(t, { maxRounds: 6 });
    await new FixedParallelRefine({ beta: 1 }).solve(env);
    const report = {
      treeIndex: t.treeIndex,
      policyId: "p",
      score: 0,
      best: 0,
      n: env.observed().size,
      k: env.rounds,
      maxParallelism: t.maxParallelism,
      batches: env.batchesTaken(),
      revealed: [...env.observed().values()],
      error: null,
      illegal: false,
      timedOut: false,
      wallMs: 0
    };
    const cell = scoreBetaCell(1, [report], () => t.baselineScore);
    expect(cell.beta).toBe(1);
    expect(cell.probes).toBe(env.observed().size);
    expect(cell.parallelPenalty).toBeGreaterThan(0);
    expect(cell.parallelPenalty).toBeLessThanOrEqual(1);
  });

  it("the parallel penalty divides by W = maxParallelism, not batch width", () => {
    // The paper defines the penalty as the mean of
    // effective_sequential_rounds / total_probes, where a batch of k on the
    // world's W workers costs ceil(k / W) sequential rounds. Deriving W from
    // the batch itself makes every full batch look perfectly parallel, so the
    // same batch must score differently on worlds with different W.
    const report = (maxParallelism: number, batch: string[]) => ({
      treeIndex: 0,
      policyId: "p",
      score: 0,
      best: 0,
      n: batch.length,
      k: 1,
      maxParallelism,
      batches: [batch],
      revealed: [],
      error: null,
      illegal: false,
      timedOut: false,
      wallMs: 0
    });
    // Two probes in one batch: W=4 needs one sequential round (1/2), W=1
    // needs two (2/2).
    const wide = scoreBetaCell(0, [report(4, ["a", "b"])], () => 0);
    const narrow = scoreBetaCell(0, [report(1, ["a", "b"])], () => 0);
    expect(wide.parallelPenalty).toBeCloseTo(1 / 2, 12);
    expect(narrow.parallelPenalty).toBeCloseTo(1, 12);
  });

  it("a serial curve has penalty near 1, a full-batch curve near 1/W", () => {
    const serial = betaSweepFromCells([
      { beta: 0, attainment: 0.1, probes: 4, rounds: 4, parallelPenalty: 1 },
      { beta: 1, attainment: 0.2, probes: 8, rounds: 8, parallelPenalty: 1 }
    ]);
    const batched = betaSweepFromCells([
      { beta: 0, attainment: 0.1, probes: 4, rounds: 2, parallelPenalty: 1 / 3 },
      { beta: 1, attainment: 0.2, probes: 8, rounds: 3, parallelPenalty: 1 / 3 }
    ]);
    expect(serial.parallelPenalty).toBeCloseTo(1, 12);
    expect(batched.parallelPenalty).toBeCloseTo(1 / 3, 12);
    // Higher lambda must penalise the serial curve more.
    expect(serial.auc - 2 * serial.parallelPenalty).toBeLessThan(
      batched.auc - 2 * batched.parallelPenalty
    );
  });

  it("flags a degenerate sweep when beta changes nothing", () => {
    const flat = betaSweepFromCells(
      BETA_SWEEP_GRID.map((beta) => ({
        beta,
        attainment: 0.3,
        probes: 4,
        rounds: 2,
        parallelPenalty: 0.5
      }))
    );
    expect(flat.degenerate).toBe(true);
    expect(flat.reward).toBeCloseTo(flat.auc, 12);
  });

  it("the sandbox hands beta to the policy constructor", async () => {
    // Two policies with the same source but different beta must produce
    // different work when the policy routes beta through its schedule.
    const source = await readFile(join(process.cwd(), "src/policies/variants/fixed.ts"), "utf8");
    const compiled = await compilePolicy({
      source,
      outDir: join(tmp, "build"),
      policyId: "beta-probe"
    });
    expect(compiled.ok, compiled.error ?? "").toBe(true);
    const t = tree(5);
    const low = await runPolicyInSandbox({
      bundlePath: compiled.bundlePath!,
      tree: t,
      priorHistory: [],
      policyId: "low",
      config: { timeoutMs: 10000, memoryMb: 256, scoreConfig: DEFAULT_SCORE_CONFIG, beta: 0 }
    });
    const high = await runPolicyInSandbox({
      bundlePath: compiled.bundlePath!,
      tree: t,
      priorHistory: [],
      policyId: "high",
      config: { timeoutMs: 10000, memoryMb: 256, scoreConfig: DEFAULT_SCORE_CONFIG, beta: 1 }
    });
    expect(low.failed).toBe(false);
    expect(high.failed).toBe(false);
    expect(high.report.n).toBeGreaterThan(low.report.n);
  });
});

describe("plan_grid", () => {
  function context(overrides: Partial<GridPlanningContext> = {}): GridPlanningContext {
    return {
      history: [],
      fallbackBranchCount: 2,
      fallbackRefineCount: 3,
      hardMaxBranchCount: 4,
      hardMaxRefineCount: 5,
      workerCap: 3,
      replaySupport: [],
      ...overrides
    };
  }

  it("the typed and sandboxed policies return a plan on every path", async () => {
    const typed = new FixedParallelRefine();
    const typedPlan = typed.planGrid(context());
    expect(typedPlan.branchCount).toBeGreaterThanOrEqual(1);
    expect(typedPlan.refineCount).toBeGreaterThanOrEqual(0);
    expect(typedPlan.reason.length).toBeGreaterThan(0);

    const source = await readFile(join(process.cwd(), "src/policies/variants/fixed.ts"), "utf8");
    const compiled = await compilePolicy({
      source,
      outDir: join(tmp, "build"),
      policyId: "plan-probe"
    });
    expect(compiled.ok, compiled.error ?? "").toBe(true);
    const mod = (await import(`${compiled.bundlePath}?t=${Date.now()}`)) as {
      default: new (cfg?: unknown) => ExplorationPolicy;
    };
    const policy = new mod.default();
    expect(typeof policy.planGrid).toBe("function");
    const variantPlan = policy.planGrid!(context());
    expect(variantPlan).toEqual(typedPlan);
  });

  it("plans stay inside the hard caps", () => {
    const plan = new FixedParallelRefine().planGrid(
      context({
        hardMaxBranchCount: 1,
        hardMaxRefineCount: 0,
        fallbackBranchCount: 9,
        fallbackRefineCount: 9
      })
    );
    expect(plan.branchCount).toBe(1);
    expect(plan.refineCount).toBe(0);
  });

  it("widens on a plateau and deepens while live best improves", () => {
    const policy = new FixedParallelRefine();
    const base = {
      round: 1,
      plannedBranchCount: 2,
      plannedRefineCount: 2,
      openedBranches: 2,
      maxAttempt: 2,
      probes: 6,
      rounds: 3,
      beta: 0.6
    };
    const plateau = policy.planGrid(
      context({
        history: [
          { ...base, round: 1, bestScore: 1.0 },
          { ...base, round: 2, bestScore: 1.0, maxAttempt: 2, openedBranches: 2 }
        ],
        replaySupport: [
          { traceBranchCount: 2, traceRefineCount: 2 },
          { traceBranchCount: 2, traceRefineCount: 2 }
        ]
      })
    );
    expect(plateau.reason).toContain("plateau");
    expect(plateau.branchCount).toBeGreaterThanOrEqual(2);

    const improving = policy.planGrid(
      context({
        history: [
          { ...base, round: 1, bestScore: 1.0 },
          { ...base, round: 2, bestScore: 1.5, maxAttempt: 2, openedBranches: 2 }
        ],
        replaySupport: [
          { traceBranchCount: 2, traceRefineCount: 2 },
          { traceBranchCount: 2, traceRefineCount: 2 }
        ]
      })
    );
    expect(improving.reason).toContain("improved");
    expect(improving.refineCount).toBeGreaterThanOrEqual(2);
  });
});

describe("live manifests and the default-beta rule", () => {
  function manifest(over: Partial<LiveCycleManifest> = {}): LiveCycleManifest {
    return {
      schema: 2,
      runId: "r",
      round: 1,
      treeIndex: 0,
      policyId: "fixed",
      plannedBranchCount: 2,
      plannedRefineCount: 2,
      planSource: "policy",
      planReason: "test",
      effectiveBranchCount: 2,
      effectiveRefineCount: 2,
      probes: 4,
      rounds: 2,
      bestScore: 1,
      baselineScore: 0,
      beta: 0.6,
      createdAt: new Date(0).toISOString(),
      ...over
    };
  }

  it("round-trips manifests and refreshes _current", async () => {
    const dir = join(tmp, "reports");
    await saveLiveManifest(dir, manifest({ round: 1 }));
    await saveLiveManifest(dir, manifest({ round: 2, beta: 0.5 }));
    const loaded = await loadLiveManifests(dir);
    expect(loaded.map((m) => m.round)).toEqual([1, 2]);
    expect(loaded[1]!.beta).toBe(0.5);
  });

  it("uses the moderate default with insufficient history", () => {
    const d = chooseDefaultBeta({
      manifests: [manifest()],
      sweep: null,
      priorBeta: null
    });
    expect(d.source).toBe("insufficient-history");
    expect(d.beta).toBe(MODERATE_DEFAULT_BETA);
  });

  it("keeps beta while live best is still improving", () => {
    const d = chooseDefaultBeta({
      manifests: [manifest({ round: 1, bestScore: 1 }), manifest({ round: 2, bestScore: 2 })],
      sweep: null,
      priorBeta: 0.6
    });
    expect(d.source).toBe("kept");
    expect(d.beta).toBe(0.6);
  });

  it("lowers beta after a plateau when high-beta points add work", () => {
    const sweep: BetaSweepPoint[] = [
      { beta: 0.4, paretoReward: 0.9, auc: 0.9, parallelPenalty: 0.9 },
      { beta: 0.6, paretoReward: 0.5, auc: 0.5, parallelPenalty: 0.95 },
      { beta: 0.8, paretoReward: 0.4, auc: 0.4, parallelPenalty: 0.99 }
    ];
    const d = chooseDefaultBeta({
      manifests: [manifest({ round: 1, bestScore: 1 }), manifest({ round: 2, bestScore: 1 })],
      sweep,
      priorBeta: 0.6
    });
    expect(d.source).toBe("lowered");
    expect(d.beta).toBeCloseTo(0.6 - BETA_STEP, 12);
  });

  it("raises beta after a plateau when higher beta buys reward", () => {
    const sweep: BetaSweepPoint[] = [
      { beta: 0.4, paretoReward: 0.4, auc: 0.4, parallelPenalty: 0.9 },
      { beta: 0.6, paretoReward: 0.5, auc: 0.5, parallelPenalty: 0.95 },
      { beta: 0.8, paretoReward: 0.9, auc: 0.9, parallelPenalty: 0.99 }
    ];
    const d = chooseDefaultBeta({
      manifests: [manifest({ round: 1, bestScore: 1 }), manifest({ round: 2, bestScore: 1 })],
      sweep,
      priorBeta: 0.6
    });
    expect(d.source).toBe("raised");
    expect(d.beta).toBeCloseTo(0.6 + BETA_STEP, 12);
  });
});

describe("branch-level observation signals", () => {
  it("exposes the paper's branch helpers on revealed observations", async () => {
    const t = tree(9);
    const env = new ReplayEnv(t, { maxRounds: 6 });
    await new FixedParallelRefine({ beta: 1 }).solve(env);
    for (const obs of env.observed().values()) {
      expect(typeof obs.branchPromising).toBe("boolean");
      expect(typeof obs.branchFailedHard).toBe("boolean");
      expect(typeof obs.improvedVsParent).toBe("boolean");
      expect(typeof obs.improvedVsBaseline).toBe("boolean");
    }
    const successful = [...env.observed().values()].filter(
      (o) => o.error === null && o.failClass === "ok"
    );
    expect(successful.length).toBeGreaterThan(0);
    // A successful evaluation that beats its baseline is an improving probe.
    for (const obs of successful) {
      if (obs.deltaVsBaseline !== null) {
        expect(obs.improvedVsBaseline).toBe(obs.deltaVsBaseline > 0);
      }
    }
  });
});

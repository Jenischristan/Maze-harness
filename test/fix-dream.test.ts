import { describe, expect, it } from "vitest";
import { ROOT_ID, TreeIndex } from "../src/tree.js";
import { IllegalBatchError, ReplayEnv } from "../src/env/replay.js";
import { computeScore, meanScoreOverGrid, RHO_GRID, DEFAULT_SCORE_CONFIG } from "../src/score.js";
import { syntheticTree } from "./synthetic.js";
import type { ExplorationEnv, ExplorationPolicy } from "../src/types.js";

function tree(seed = 3) {
  return syntheticTree({
    seed,
    branches: 3,
    refinements: 3,
    failRate: 0.1,
    dominantBranch: 1,
    dominantBoost: 0.7,
    maxParallelism: 3,
    roundsLimit: 6
  });
}

describe("live/replay legality parity", () => {
  it("replay legalActions == revealed leaves + root", async () => {
    const t = tree();
    const idx = new TreeIndex(t);
    const env = new ReplayEnv(t, { maxRounds: 6 });
    expect(env.legalActions()).toEqual([ROOT_ID]);

    await env.probeBatch([ROOT_ID]);
    const revealed = new Set(env.observed().keys());
    const expected = [ROOT_ID, ...idx.leaves(revealed).map((n) => n.id)];
    expect(env.legalActions().sort()).toEqual(expected.sort());
  });

  it("openedBranches only exposes branches already revealed", async () => {
    const t = tree();
    const env = new ReplayEnv(t, { maxRounds: 6 });
    expect(env.openedBranches()).toEqual([]);
    await env.probeBatch([ROOT_ID]);
    const revealedBranches = new Set([...env.observed().values()].map((o) => o.branch));
    expect(new Set(env.openedBranches())).toEqual(revealedBranches);

    for (const b of env.openedBranches()) expect(revealedBranches.has(b)).toBe(true);
  });

  it("rejects a batch larger than maxParallelism", async () => {
    const env = new ReplayEnv(tree(), { maxRounds: 6 });

    await expect(env.probeBatch([ROOT_ID, ROOT_ID, ROOT_ID, ROOT_ID])).rejects.toThrow(
      IllegalBatchError
    );
  });

  it("rejects duplicates and non-eligible ids", async () => {
    const t = tree();
    const env = new ReplayEnv(t, { maxRounds: 6 });
    await env.probeBatch([ROOT_ID]);
    const leaf = env.legalActions().filter((id) => id !== ROOT_ID)[0]!;
    expect(() => env.validateBatch([leaf, leaf])).toThrow(IllegalBatchError);
    expect(() => env.validateBatch(["nope"])).toThrow(IllegalBatchError);
  });

  it("records a legal no-op leaf probe as a consumed round", async () => {
    const t = tree();
    const env = new ReplayEnv(t, { maxRounds: 6 });
    await env.probeBatch([ROOT_ID]);
    const leaf = env.legalActions().filter((id) => id !== ROOT_ID)[0]!;
    const before = env.rounds;
    await env.probeBatch([leaf]);

    expect(env.rounds).toBe(before + 1);
    expect(env.batchesTaken().at(-1)).toEqual([leaf]);
  });

  it("probeBatch on a done env throws", async () => {
    const env = new ReplayEnv(tree(), { maxRounds: 1 });
    await env.probeBatch([ROOT_ID]);
    expect(env.done).toBe(true);
    await expect(env.probeBatch([ROOT_ID])).rejects.toThrow(IllegalBatchError);
  });
});

describe("replay objective", () => {
  it("classic objective when rho/lambda are unset", () => {
    const comp = computeScore({
      baselineScore: 1,
      revealedScores: [1.5, 2, 0.5],
      rounds: 2,
      config: { beta1: 0.002, beta2: 0.01, normalize: "none" }
    });
    expect(comp.score).toBeCloseTo(2 - 0.002 * 3 + (0.01 * 3) / 2, 12);
  });

  it("lambda penalises wasted width, not node count", () => {
    const base = {
      baselineScore: 0,
      revealedScores: [1, 1, 1],
      rounds: 1,
      config: { beta1: 0, beta2: 0, normalize: "none" as const, lambda: 0.1 }
    };
    const sequential = computeScore({ ...base, batchSizes: [1, 1, 1] });
    const wide = computeScore({ ...base, batchSizes: [3] });

    expect(wide.penalty).toBeCloseTo(0.2, 12);
    expect(sequential.penalty).toBeCloseTo(0, 12);
  });

  it("nothing revealed => V equals baseline", () => {
    const comp = computeScore({
      baselineScore: 4.2,
      revealedScores: [],
      rounds: 0,
      config: { ...DEFAULT_SCORE_CONFIG, normalize: "none" }
    });
    expect(comp.score).toBeCloseTo(4.2, 12);
  });

  it("meanScoreOverGrid averages each rho cell", () => {
    const t = tree();
    const reports = [0, 1].map((i) => ({
      treeIndex: i,
      policyId: "p",
      score: 0,
      best: 0,
      n: 4,
      k: 2,
      maxParallelism: 2,
      batches: [["root", "root"]],
      revealed: [],
      error: null,
      illegal: false,
      timedOut: false,
      wallMs: 0
    }));
    const mean = meanScoreOverGrid(reports, { beta1: 0, beta2: 0, normalize: "none" }, () => 0);
    expect(Number.isFinite(mean)).toBe(true);
    expect(RHO_GRID.length).toBeGreaterThan(1);
  });
});

describe("scripted end-to-end replay", () => {
  it("a greedy policy beats a fixed one on a dominant-branch tree", async () => {
    const t = tree(11);

    class Greedy implements ExplorationPolicy {
      async solve(env: ExplorationEnv): Promise<void> {
        while (env.roundsRemaining > 0 && env.legalRoots() > 0) {
          await env.probeBatch([ROOT_ID]);
        }
        for (let r = 0; r < 20 && !env.done; r += 1) {
          const leaves = [...env.observed().values()].filter((o) => {
            const kids = [...env.observed().values()].filter((c) => c.parentId === o.id);
            return kids.length === 0;
          });
          if (leaves.length === 0) break;
          const best = leaves.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0]!;
          await env.probeBatch([best.id]);
        }
      }
    }

    const greedy = new ReplayEnv(t, { maxRounds: 6 });
    await new Greedy().solve(greedy);
    const greedyScore = computeScore({
      baselineScore: t.baselineScore,
      revealedScores: greedy.revealedObservations().map((o) => o.score),
      rounds: greedy.rounds,
      config: DEFAULT_SCORE_CONFIG
    }).score;

    const fixed = new ReplayEnv(t, { maxRounds: 6 });

    await fixed.probeBatch([ROOT_ID, ROOT_ID, ROOT_ID]);
    const fixedScore = computeScore({
      baselineScore: t.baselineScore,
      revealedScores: fixed.revealedObservations().map((o) => o.score),
      rounds: fixed.rounds,
      config: DEFAULT_SCORE_CONFIG
    }).score;

    expect(greedyScore).toBeGreaterThan(fixedScore);
  });
});

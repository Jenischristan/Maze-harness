import { describe, expect, it } from "vitest";
import { ROOT_ID, TreeIndex, toObservation } from "../src/tree.js";
import { IllegalBatchError, ReplayEnv } from "../src/env/replay.js";
import { computeScore, DEFAULT_SCORE_CONFIG, meanScoreOverGrid } from "../src/score.js";
import { FixedParallelRefine } from "../src/policies/fixedParallelRefine.js";
import { meanScore, scoreReplay } from "../src/score.js";
import { syntheticTree } from "./synthetic.js";
import type { ExplorationEnv, ExplorationPolicy, Observation } from "../src/types.js";

function tree() {
  return syntheticTree({
    seed: 7,
    branches: 3,
    refinements: 3,
    failRate: 0.2,
    dominantBranch: 1,
    dominantBoost: 0.6
  });
}

describe("tree index", () => {
  it("orders root children by seq and exposes leaves", () => {
    const idx = new TreeIndex(tree());
    const revealed = new Set(idx.nodes.map((n) => n.id));
    const leaves = idx.leaves(revealed);
    expect(leaves).toHaveLength(3);
    expect(leaves.map((n) => n.branch)).toEqual([0, 1, 2]);
    expect(idx.firstUnrevealedRootChild(new Set())?.branch).toBe(0);
  });
});

describe("replay env", () => {
  it("is deterministic for the same decisions", async () => {
    const t = tree();
    const run = async () => {
      const env = new ReplayEnv(t, { maxRounds: 6 });
      await env.probeBatch([ROOT_ID]);
      const leaves = env.legalActions().filter((id) => id !== ROOT_ID);
      await env.probeBatch(leaves.slice(0, 2));
      await env.probeBatch([ROOT_ID]);
      return {
        batches: env.batchesTaken(),
        revealed: env.revealedObservations(),
        rounds: env.rounds
      };
    };
    expect(await run()).toEqual(await run());
  });

  it("never leaks unrevealed nodes", async () => {
    const t = tree();
    const env = new ReplayEnv(t, { maxRounds: 6 });
    expect(env.observed().size).toBe(0);
    expect(env.legalActions()).toEqual([ROOT_ID]);
    await env.probeBatch([ROOT_ID]);
    expect(env.observed().size).toBe(1);
    expect(env.legalActions()).toHaveLength(2);
    for (const obs of env.observed().values()) {
      const node = t.nodes.find((n) => n.id === obs.id);
      expect(node).toBeDefined();
    }
    expect(env.legalRoots()).toBe(t.nodes.filter((n) => n.parentId === ROOT_ID).length - 1);
  });

  it("root probe reveals the earliest unrevealed branch", async () => {
    const t = tree();
    const env = new ReplayEnv(t, { maxRounds: 6 });
    const [first] = await env.probeBatch([ROOT_ID]);
    const roots = t.nodes.filter((n) => n.parentId === ROOT_ID).sort((a, b) => a.seq - b.seq);
    expect(first?.id).toBe(roots[0]?.id);
    const [second] = await env.probeBatch([ROOT_ID]);
    expect(second?.id).toBe(roots[1]?.id);
  });

  it("stops on empty batch, round limit and full reveal", async () => {
    const t = tree();
    const empty = new ReplayEnv(t, { maxRounds: 5 });
    await empty.probeBatch([]);
    expect(empty.done).toBe(true);
    expect(empty.rounds).toBe(0);

    const limited = new ReplayEnv(t, { maxRounds: 1 });
    await limited.probeBatch([ROOT_ID]);
    expect(limited.done).toBe(true);
    expect(limited.roundsRemaining).toBe(0);
  });

  it("rejects illegal batches", async () => {
    const env = new ReplayEnv(tree(), { maxRounds: 6 });
    await expect(env.probeBatch(["b0a0"])).rejects.toBeInstanceOf(IllegalBatchError);
    await expect(env.probeBatch([ROOT_ID, ROOT_ID, ROOT_ID, ROOT_ID, ROOT_ID])).rejects.toBeInstanceOf(
      IllegalBatchError
    );
    await env.probeBatch([ROOT_ID, ROOT_ID]);
    const leaves = env.legalActions().filter((id) => id !== ROOT_ID);
    await expect(env.probeBatch([leaves[0]!, leaves[0]!])).rejects.toBeInstanceOf(
      IllegalBatchError
    );
  });

  it("returns nothing for a leaf with no recorded child but still counts the round", async () => {
    const t = syntheticTree({ seed: 1, branches: 1, refinements: 1, maxParallelism: 2, roundsLimit: 5 });
    const env = new ReplayEnv(t, { maxRounds: 5 });
    await env.probeBatch([ROOT_ID]);
    const leaf = env.legalActions().filter((id) => id !== ROOT_ID)[0]!;
    const got = await env.probeBatch([leaf]);
    expect(got).toEqual([]);
    expect(env.rounds).toBe(2);
  });
});

describe("score", () => {
  it("matches the classic hand-computed example when rho is unset", () => {
    const comp = computeScore({
      baselineScore: 1,
      revealedScores: [1.5, null, 2, 0.5],
      rounds: 2,
      config: { beta1: 0.002, beta2: 0.01, normalize: "none" }
    });
    expect(comp.best).toBe(2);
    expect(comp.n).toBe(4);
    expect(comp.k).toBe(2);
    expect(comp.penalty).toBeCloseTo(0.008, 12);
    expect(comp.bonus).toBeCloseTo(0.02, 12);
    expect(comp.score).toBeCloseTo(2 - 0.008 + 0.02, 12);
  });

  it("matches Eq. (1) exactly: V = best - b1*N + b2*N/k with no budget term", () => {
    // Paper Eq. (1) is the whole replay objective. There is no budget-
    // preference term, so a rho value must not change the score.
    const comp = computeScore({
      baselineScore: 0,
      revealedScores: [1, 1, 1],
      rounds: 2,
      config: { beta1: 0.01, beta2: 0.2, normalize: "none" }
    });
    expect(comp.penalty).toBeCloseTo(0.01 * 3, 12);
    expect(comp.bonus).toBeCloseTo((0.2 * 3) / 2, 12);
    expect(comp.score).toBeCloseTo(1 - 0.03 + 0.3, 12);
  });

  it("rho=0 rewards spend and rho=1 rewards fewer rounds (documented budget terms)", () => {
    // README documents the opt-in rho budget terms:
    //   - rho*gamma*N/k   speed preference (fewer rounds)
    //   + (1-rho)*gamma*N spend preference (more probes)
    // with gamma = 0.01 only when rho is explicitly set.
    const spendPref = computeScore({
      baselineScore: 0,
      revealedScores: [1, 1, 1, 1],
      rounds: 2,
      config: { beta1: 0, beta2: 0, normalize: "none", rho: 0 }
    });
    const speedPref = computeScore({
      baselineScore: 0,
      revealedScores: [1, 1, 1, 1],
      rounds: 2,
      config: { beta1: 0, beta2: 0, normalize: "none", rho: 1 }
    });
    // rho=0: +gamma*N = 0.01*4 = +0.04 over best.
    expect(spendPref.score).toBeCloseTo(1 + 0.04, 12);
    // rho=1: -gamma*N/k = -0.01*4/2 = -0.02 over best.
    expect(speedPref.score).toBeCloseTo(1 - 0.02, 12);
    expect(spendPref.score).toBeGreaterThan(speedPref.score);
  });

  it("scores over the full rho grid", () => {
    const reports = [
      {
        treeIndex: 0,
        policyId: "p",
        score: 0,
        best: 0,
        n: 4,
        k: 2,
        maxParallelism: 2,
        batches: [],
        revealed: [
          { id: "a", branch: 0, attempt: 0, parentId: "root", seq: 0, score: 2, valid: true, failClass: "ok", error: null, deltaVsBaseline: 1, deltaVsParent: null, nValid: null, nTotal: null, tags: [], branchPromising: true, branchFailedHard: false, improvedVsParent: false, improvedVsBaseline: true }
        ],
        error: null,
        illegal: false,
        timedOut: false,
        wallMs: 0
      }
    ];
    const grid = meanScoreOverGrid(
      reports,
      { beta1: 0, beta2: 0, normalize: "none" },
      () => 0
    );
    expect(Number.isFinite(grid)).toBe(true);
    expect(grid).toBeGreaterThan(1.9);
  });

  it("normalizes relative to baseline by default", () => {
    const comp = computeScore({
      baselineScore: 2,
      revealedScores: [3],
      rounds: 1,
      config: DEFAULT_SCORE_CONFIG
    });
    expect(comp.best).toBeCloseTo(0.5, 12);
  });

  it("falls back to baseline when nothing was revealed", () => {
    const comp = computeScore({
      baselineScore: 4,
      revealedScores: [],
      rounds: 0,
      config: { beta1: 0.002, beta2: 0.01, normalize: "none" }
    });
    expect(comp.best).toBe(4);
    expect(comp.penalty).toBe(0);
    expect(comp.bonus).toBe(0);
    expect(comp.score).toBe(4);
  });
});

describe("fixed policy vs greedy", () => {
  it("greedy beats FixedParallelRefine on a dominant branch tree", async () => {
    const t = syntheticTree({
      seed: 11,
      branches: 4,
      refinements: 6,
      failRate: 0.1,
      dominantBranch: 1,
      dominantBoost: 2.5,
      maxParallelism: 3,
      roundsLimit: 8
    });

    class Greedy implements ExplorationPolicy {
      async solve(env: ExplorationEnv): Promise<void> {
        await env.probeBatch([ROOT_ID, ROOT_ID, ROOT_ID]);
        const attempted = new Set<string>();
        for (let r = 0; r < 20 && !env.done; r += 1) {
          const leaves: Observation[] = [];
          const parents = new Set([...env.observed().values()].map((o) => o.parentId));
          for (const obs of env.observed().values()) if (!parents.has(obs.id)) leaves.push(obs);
          const byBranch = new Map<number, Observation>();
          for (const leaf of leaves) {
            const cur = byBranch.get(leaf.branch);
            if (!cur || leaf.seq > cur.seq) byBranch.set(leaf.branch, leaf);
          }
          const target = [...byBranch.values()]
            .filter((l) => !attempted.has(l.id))
            .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
          if (!target) {
            const fresh = leaves.filter((l) => !attempted.has(l.id))[0];
            if (!fresh) return;
            attempted.add(fresh.id);
            await env.probeBatch([fresh.id]);
            continue;
          }
          attempted.add(target.id);
          await env.probeBatch([target.id]);
        }
      }
    }

    const greedyReports = [];
    const fixedReports = [];
    for (let i = 0; i < 5; i += 1) {
      const treeI = { ...t, treeIndex: i };
      const ge = new ReplayEnv(treeI, { maxRounds: treeI.roundsLimit });
      await new Greedy().solve(ge);
      greedyReports.push(scoreReplay(treeI, ge, "greedy", DEFAULT_SCORE_CONFIG));
      const fe = new ReplayEnv(treeI, { maxRounds: treeI.roundsLimit });
      await new FixedParallelRefine({ branches: 4, refinements: 4 }).solve(fe);
      fixedReports.push(scoreReplay(treeI, fe, "fixed", DEFAULT_SCORE_CONFIG));
    }
    expect(meanScore(greedyReports)).toBeGreaterThan(meanScore(fixedReports));
  });
});

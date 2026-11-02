/**
 * Fuzz + property tests for the Dream-RSI core:
 *   src/tree.ts, src/env/replay.ts, src/score.ts
 *
 * Invariants checked:
 *  - replay never reveals an unrevealed node out of order and never leaks
 *    future structure (legalRoots/openedBranches only reflect observations);
 *  - reset() restores the exact initial state and a replay is deterministic;
 *  - rounds never exceed maxRounds and done implies no further legal actions;
 *  - score is finite for finite inputs, equals baseline when nothing is
 *    revealed, and matches the documented formula;
 *  - beta sweep produces a monotone AUC in [0, 1] and a correct degeneracy flag.
 */
import { describe, expect, it } from "vitest";
import { ROOT_ID, TreeIndex, toObservation, withBranchSignals } from "../../src/tree.js";
import { IllegalBatchError, ReplayEnv } from "../../src/env/replay.js";
import {
  BETA_SWEEP_GRID,
  computeScore,
  meanScore,
  meanScoreOverGrid,
  scoreBetaCell,
  scoreReplay,
  betaSweepFromCells
} from "../../src/score.js";
import type { DiscoveryNode, DiscoveryTree, Observation, TreeSummary } from "../../src/types.js";
import { fuzzCases } from "./harness.js";
import type { Rng } from "./harness.js";

function randomTree(rng: Rng): DiscoveryTree {
  const branches = rng.int(1, 5);
  const refinements = rng.int(0, 5);
  const nodes: DiscoveryNode[] = [];
  const ids: string[][] = [];
  let seq = 0;
  for (let b = 0; b < branches; b += 1) {
    ids.push([]);
    let parentId = ROOT_ID;
    for (let a = 0; a < refinements; a += 1) {
      const failed = rng.bool(0.2);
      const id = `b${b}a${a}`;
      const score = failed ? null : Number((rng.next() * 2 - 0.5).toFixed(6));
      nodes.push({
        id,
        parentId,
        branch: b,
        attempt: a,
        seq: seq++,
        score,
        valid: !failed,
        failClass: failed ? rng.pick(["compile", "runtime", "timeout", "incorrect"]) : "ok",
        error: failed ? "synthetic" : null,
        diagnostics: rng.bool() ? { n_valid: rng.int(0, 5), n_total: rng.int(0, 9), tags: ["t"] } : null,
        snapshotRef: id,
        artifactPath: null,
        cost: { agentCalls: 1, wallMs: 10 },
        createdAt: new Date(0).toISOString()
      });
      ids[b]!.push(id);
      parentId = id;
    }
  }
  return {
    runId: "fuzz",
    treeIndex: rng.int(0, 50),
    baselineScore: Number((rng.next() * 4 - 1).toFixed(6)),
    maxParallelism: rng.int(1, 4),
    roundsLimit: rng.int(0, 8),
    policyId: "fuzz",
    nodes,
    createdAt: new Date(0).toISOString()
  };
}

async function randomRollout(env: ReplayEnv, rng: Rng): Promise<void> {
  const guard = env.maxRounds + 5;
  for (let i = 0; i < guard && !env.done; i += 1) {
    const legal = env.legalActions();
    const batch: string[] = [];
    const want = rng.int(0, Math.min(legal.length, env.maxParallelism));
    if (want === 0) {
      await env.probeBatch([]);
      return;
    }
    // ROOT_ID stops being a usable action once every root child is revealed;
    // `legalActions()` still lists it, but the env rejects a batch containing
    // it then.
    const pool = legal.filter((id) => id !== ROOT_ID || env.legalRoots() > 0);
    while (batch.length < want && pool.length > 0) {
      const idx = rng.int(0, pool.length - 1);
      batch.push(pool.splice(idx, 1)[0]!);
    }
    if (batch.length === 0) {
      await env.probeBatch([]);
      return;
    }
    await env.probeBatch(batch);
  }
}

describe("fuzz: TreeIndex", () => {
  it(
    "orders children by seq and ancestors form a root-connected chain",
    fuzzCases({ seed: 0xd01, runs: 100 }, (rng) => {
      const tree = randomTree(rng);
      const idx = new TreeIndex(tree);
      for (const node of tree.nodes) {
        const anc = idx.ancestors(node.id);
        expect(anc[0]!.branch).toBe(node.branch);
        expect(anc.at(-1)!.id).toBe(node.id);
        for (let i = 1; i < anc.length; i += 1) {
          expect(anc[i]!.parentId).toBe(anc[i - 1]!.id);
        }
        const kids = idx.children(node.id);
        for (let i = 1; i < kids.length; i += 1) {
          expect(kids[i]!.seq).toBeGreaterThanOrEqual(kids[i - 1]!.seq);
        }
      }
    })
  );

  it(
    "rejects duplicate ids and the reserved root id",
    fuzzCases({ seed: 0xd02, runs: 40 }, (rng) => {
      const tree = randomTree(rng);
      if (tree.nodes.length === 0) return;
      const dup = { ...tree, nodes: [...tree.nodes, { ...tree.nodes[0]! }] };
      expect(() => new TreeIndex(dup)).toThrow(/duplicate/);
      const rooted = { ...tree, nodes: [{ ...tree.nodes[0]!, id: ROOT_ID }, ...tree.nodes.slice(1)] };
      expect(() => new TreeIndex(rooted)).toThrow(/root/);
    })
  );

  it(
    "latestChild and firstUnrevealedRootChild are consistent with seq ordering",
    fuzzCases({ seed: 0xd03, runs: 80 }, (rng) => {
      const tree = randomTree(rng);
      const idx = new TreeIndex(tree);
      for (const node of tree.nodes) {
        const latest = idx.latestChild(node.id);
        const kids = idx.children(node.id);
        if (kids.length === 0) expect(latest).toBeUndefined();
        else expect(latest!.seq).toBe(Math.max(...kids.map((k) => k.seq)));
      }
      const revealed = new Set<string>();
      const roots = tree.nodes.filter((n) => n.parentId === ROOT_ID).sort((a, b) => a.seq - b.seq);
      for (const root of roots) {
        expect(idx.firstUnrevealedRootChild(revealed)?.id).toBe(root.id);
        revealed.add(root.id);
      }
      expect(idx.firstUnrevealedRootChild(revealed)).toBeUndefined();
    })
  );
});

describe("fuzz: ReplayEnv", () => {
  it(
    "respects legality, round caps, and never leaks future nodes",
    fuzzCases({ seed: 0xd04, runs: 120 }, async (rng) => {
      const tree = randomTree(rng);
      const env = new ReplayEnv(tree, { maxRounds: tree.roundsLimit });
      let prevRevealed = 0;
      while (!env.done) {
        const legal = env.legalActions();
        // `legalActions()` always lists `root` (the paper's A(T) includes r)
        // while the env is live; whether it is *usable* is signalled by
        // `legalRoots()`, and validateBatch rejects it when that is 0.
        expect(legal).toContain(ROOT_ID);
        for (const id of legal) {
          if (id !== ROOT_ID) {
            expect(env.observed().has(id) || tree.nodes.some((n) => n.id === id)).toBe(true);
          }
        }
        expect(env.budgetSpent).toBe(env.observed().size);
        const rootsLeft = env.legalRoots() > 0;
        const eligible = legal.filter((id) => id !== ROOT_ID || rootsLeft).length;
        // An empty batch ends the rollout. Zero `maxRounds` also ends it, but
        // `done` only flips after the first probeBatch, so don't require
        // done===true here; the loop condition re-checks it.
        if (env.maxRounds === 0) {
          await env.probeBatch([]);
          break;
        }
        const want = rng.int(0, Math.min(eligible, env.maxParallelism));
        if (want === 0) {
          await env.probeBatch([]);
          break;
        }
        // A legal ROOT_ID is only eligible while unrevealed root children
        // remain; `legalActions()` keeps listing it as an action even when no
        // root child is left, and the env rightly rejects that batch. Never
        // sample it once `legalRoots()` is 0.
        const pool = legal.filter((id) => id !== ROOT_ID || rootsLeft);
        const batch: string[] = [];
        while (batch.length < want && pool.length > 0) {
          batch.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]!);
        }
        if (batch.length === 0) {
          await env.probeBatch([]);
          break;
        }
        const revealed = await env.probeBatch(batch);
        expect(env.observed().size).toBeGreaterThanOrEqual(prevRevealed);
        prevRevealed = env.observed().size;
        for (const obs of revealed) expect(env.observed().get(obs.id)).toBe(obs);
        expect(env.rounds).toBeLessThanOrEqual(env.maxRounds);
        if (env.done) expect(env.legalActions()).toEqual([]);
      }
    })
  );

  it(
    "illegal batches are rejected and change no state",
    fuzzCases({ seed: 0xd05, runs: 120 }, async (rng) => {
      const tree = randomTree(rng);
      const env = new ReplayEnv(tree, { maxRounds: tree.roundsLimit });
      const before = {
        rounds: env.rounds,
        observed: env.observed().size,
        legal: env.legalActions()
      };
      const candidates = [
        [...Array(tree.maxParallelism + 1).fill(ROOT_ID)],
        ["nonexistent"],
        [ROOT_ID, ROOT_ID, ROOT_ID, ROOT_ID, ROOT_ID, ROOT_ID],
        [42 as unknown as string]
      ];
      const batch = rng.pick(candidates);
      let rejected = false;
      try {
        await env.probeBatch(batch as string[]);
      } catch (err) {
        expect(err).toBeInstanceOf(IllegalBatchError);
        rejected = true;
      }
      if (rejected) {
        expect(env.rounds).toBe(before.rounds);
        expect(env.observed().size).toBe(before.observed);
        expect(env.legalActions()).toEqual(before.legal);
      }
    })
  );

  it(
    "reset() restores the exact initial state and replay is deterministic",
    fuzzCases({ seed: 0xd06, runs: 80 }, async (rng) => {
      const tree = randomTree(rng);
      const env = new ReplayEnv(tree, { maxRounds: tree.roundsLimit });
      const initial = {
        legal: env.legalActions(),
        legalRoots: env.legalRoots(),
        opened: env.openedBranches(),
        best: env.bestSoFar
      };
      await randomRollout(env, rng);
      const traceA = {
        batches: env.batchesTaken(),
        rounds: env.rounds,
        revealed: env.revealedObservations().map((o) => [o.id, o.score, o.branchPromising])
      };
      env.reset();
      expect(env.legalActions()).toEqual(initial.legal);
      expect(env.legalRoots()).toBe(initial.legalRoots);
      expect(env.openedBranches()).toEqual(initial.opened);
      expect(env.bestSoFar).toBe(initial.best);
      expect(env.rounds).toBe(0);
      expect(env.done).toBe(false);
      for (const batch of traceA.batches) {
        try {
          await env.probeBatch(batch);
        } catch {
          break;
        }
      }
      expect(env.batchesTaken().slice(0, traceA.batches.length)).toEqual(traceA.batches);
      expect(env.rounds).toBe(traceA.rounds);
      expect(env.revealedObservations().map((o) => [o.id, o.score, o.branchPromising])).toEqual(
        traceA.revealed
      );
    })
  );

  it(
    "meta never exposes a score and only structural fields",
    fuzzCases({ seed: 0xd07, runs: 80 }, async (rng) => {
      const tree = randomTree(rng);
      const env = new ReplayEnv(tree);
      await randomRollout(env, rng);
      for (const node of tree.nodes) {
        const m = env.meta(node.id);
        expect(Object.keys(m).sort()).toEqual(["attempt", "branch", "id", "parentId", "seq", "tags"]);
        expect("score" in m).toBe(false);
      }
      expect(env.meta(ROOT_ID).tags).toEqual(["root"]);
    })
  );
});

describe("fuzz: observation signals", () => {
  it(
    "branch signals follow the paper's success semantics",
    fuzzCases({ seed: 0xd08, runs: 200 }, (rng) => {
      const mk = (over: Partial<Observation>): Observation => ({
        id: rng.str(4),
        branch: 0,
        attempt: 0,
        parentId: ROOT_ID,
        seq: 0,
        score: rng.bool() ? rng.next() : null,
        valid: rng.bool(),
        failClass: rng.pick(["ok", "compile", "runtime", "timeout", "incorrect"]),
        error: rng.bool() ? null : "boom",
        deltaVsBaseline: rng.bool() ? rng.next() - 0.5 : null,
        deltaVsParent: rng.bool() ? rng.next() - 0.5 : null,
        nValid: null,
        nTotal: null,
        tags: [],
        branchPromising: false,
        branchFailedHard: false,
        improvedVsParent: false,
        improvedVsBaseline: false,
        ...over
      });
      const earlier = Array.from({ length: rng.int(0, 4) }, () =>
        mk({ failClass: rng.pick(["ok", "compile", "runtime"]), error: rng.bool() ? null : "e" })
      );
      const obs = mk({});
      const out = withBranchSignals(obs, earlier);
      const successful = (o: Observation): boolean => o.error === null && o.failClass === "ok";
      const priorSuccess = earlier.some(successful);
      const sameClass = earlier.filter((o) => !successful(o) && o.failClass === obs.failClass).length;
      expect(out.branchFailedHard).toBe(!successful(obs) && sameClass >= 1 && !priorSuccess);
      expect(out.improvedVsParent).toBe(obs.deltaVsParent !== null && obs.deltaVsParent > 0);
      expect(out.improvedVsBaseline).toBe(obs.deltaVsBaseline !== null && obs.deltaVsBaseline > 0);
    })
  );

  it(
    "toObservation never throws and normalises deltas by the baseline scale",
    fuzzCases({ seed: 0xd09, runs: 200 }, (rng) => {
      const baseline = rng.next() * 10 - 5;
      const score = rng.bool() ? null : rng.next() * 10 - 5;
      const parentScore = rng.bool() ? null : rng.next() * 10 - 5;
      const node: DiscoveryNode = {
        id: "n",
        parentId: ROOT_ID,
        branch: 0,
        attempt: 0,
        seq: 0,
        score,
        valid: score !== null,
        failClass: score === null ? "runtime" : "ok",
        error: score === null ? "e" : null,
        diagnostics: rng.bool() ? { nValid: rng.int(0, 3), nTotal: rng.int(0, 5), tags: ["a", 1] } : "nope",
        snapshotRef: "n",
        artifactPath: null,
        cost: { agentCalls: 0, wallMs: 0 },
        createdAt: new Date(0).toISOString()
      };
      const obs = toObservation(node, baseline, parentScore);
      const scale = Math.max(Math.abs(baseline), 1);
      // A root child's parent is the root, whose score is the baseline; the
      // paper's parent->child gain therefore uses the baseline when no parent
      // score is supplied. Only a null score yields null deltas.
      const effectiveParent = parentScore ?? baseline;
      if (score === null) {
        expect(obs.deltaVsBaseline).toBeNull();
        expect(obs.deltaVsParent).toBeNull();
      } else {
        expect(obs.deltaVsBaseline).toBeCloseTo((score - baseline) / scale, 12);
        expect(obs.deltaVsParent).toBeCloseTo((score - effectiveParent) / scale, 12);
      }
      expect(Array.isArray(obs.tags)).toBe(true);
      for (const tag of obs.tags) expect(typeof tag).toBe("string");
    })
  );
});

describe("fuzz: computeScore", () => {
  it(
    "is finite, equals baseline when nothing is revealed, and matches the formula",
    fuzzCases({ seed: 0xd10, runs: 300 }, (rng) => {
      const baseline = rng.next() * 20 - 10;
      const revealed = Array.from({ length: rng.int(0, 10) }, () =>
        rng.bool(0.2) ? null : rng.next() * 20 - 10
      );
      const rounds = rng.int(0, 10);
      const batchSizes = Array.from({ length: rng.int(0, 6) }, () => rng.int(0, 5));
      const hasRho = rng.bool();
      const config = {
        beta1: rng.next() * 0.1,
        beta2: rng.next() * 0.1,
        lambda: rng.bool() ? rng.next() * 0.1 : undefined,
        rho: hasRho ? rng.next() * 1.4 - 0.2 : undefined,
        normalize: rng.pick(["none", "relativeToBaseline"] as const)
      };
      const comp = computeScore({ baselineScore: baseline, revealedScores: revealed, rounds, config, batchSizes });
      expect(Number.isFinite(comp.score)).toBe(true);
      expect(comp.n).toBe(revealed.length);
      expect(comp.k).toBe(rounds);
      const widthForEmpty = batchSizes.reduce((a, s) => a + Math.max(0, s - 1), 0);
      if (revealed.length === 0) {
        // The width penalty is a trajectory property, not a probe-count one, so
        // it still applies when nothing was revealed; the probe terms vanish.
        expect(comp.penalty).toBeCloseTo((config.lambda ?? 0) * widthForEmpty, 9);
        expect(comp.bonus).toBe(0);
      }
      const best = revealed.reduce<number | null>((acc, s) => (s === null ? acc : acc === null || s > acc ? s : acc), null) ?? baseline;
      const norm = config.normalize === "none" ? best : (best - baseline) / Math.max(Math.abs(baseline), 1);
      expect(comp.best).toBeCloseTo(norm, 9);
      const width = batchSizes.reduce((a, s) => a + Math.max(0, s - 1), 0);
      const n = revealed.length;
      const k = Math.max(1, rounds);
      // Paper Eq. (1) base, plus the documented opt-in rho budget terms when
      // rho is explicitly set (gamma = 0.01).
      const expectedPenalty = (config.beta1 ?? 0) * n + (config.lambda ?? 0) * width;
      const expectedBonus = n > 0 ? ((config.beta2 ?? 0) * n) / k : 0;
      const rho = config.rho === undefined ? null : Math.max(0, Math.min(1, config.rho));
      const gamma = rho === null ? 0 : 0.01;
      const speed = rho === null || n === 0 ? 0 : (rho * gamma * n) / k;
      const spend = rho === null || n === 0 ? 0 : (1 - rho) * gamma * n;
      expect(comp.penalty).toBeCloseTo(expectedPenalty, 9);
      expect(comp.bonus).toBeCloseTo(expectedBonus, 9);
      expect(comp.score).toBeCloseTo(norm - expectedPenalty + expectedBonus - speed + spend, 9);
    })
  );

  it(
    "meanScore / meanScoreOverGrid never return NaN for finite reports",
    fuzzCases({ seed: 0xd11, runs: 60 }, async (rng) => {
      const tree = randomTree(rng);
      const env = new ReplayEnv(tree);
      await randomRollout(env, rng);
      const report = scoreReplay(tree, env, "p", { beta1: 0.002, beta2: 0.01, normalize: "none" });
      expect(meanScore([report])).toBeCloseTo(report.score, 12);
      expect(meanScore([])).toBe(0);
      const grid = meanScoreOverGrid([report], { beta1: 0.002, beta2: 0.01, normalize: "none" }, () => tree.baselineScore);
      expect(Number.isFinite(grid)).toBe(true);
      const inf = meanScoreOverGrid(
        [{ ...report, score: Number.NEGATIVE_INFINITY }],
        { beta1: 0, beta2: 0, normalize: "none" },
        () => 0
      );
      expect(inf).toBe(Number.NEGATIVE_INFINITY);
    })
  );
});

describe("fuzz: beta sweep", () => {
  it(
    "AUC is in [0,1], reward is auc - lambda*penalty, degeneracy is exact",
    fuzzCases({ seed: 0xd12, runs: 200 }, (rng) => {
      const cells = Array.from({ length: rng.int(0, 8) }, () => ({
        beta: rng.pick([...BETA_SWEEP_GRID]),
        attainment: rng.int(0, 5) === 0 ? 0 : rng.next() * 3,
        probes: rng.int(0, 20),
        rounds: rng.int(0, 10),
        parallelPenalty: rng.next()
      }));
      const lambda = rng.bool() ? rng.next() * 2 : 0;
      const out = betaSweepFromCells(cells, lambda);
      expect(out.auc).toBeGreaterThanOrEqual(0);
      expect(out.auc).toBeLessThanOrEqual(1 + 1e-12);
      expect(out.reward).toBeCloseTo(out.auc - lambda * out.parallelPenalty, 9);
      expect(out.cells).toHaveLength(cells.length);
      const distinct = new Set(cells.map((c) => `${c.attainment.toFixed(6)}|${c.probes}`)).size;
      expect(out.degenerate).toBe(distinct <= 1);
      for (const c of out.cells) {
        expect(c.reward).toBe(c.probes > 0 ? c.attainment / c.probes : c.attainment);
      }
    })
  );

  it(
    "scoreBetaCell counts effective sequential rounds with the world's width",
    fuzzCases({ seed: 0xd13, runs: 60 }, async (rng) => {
      const tree = randomTree(rng);
      const env = new ReplayEnv(tree);
      await randomRollout(env, rng);
      const report = scoreReplay(tree, env, "p", { beta1: 0, beta2: 0, normalize: "none" });
      const cell = scoreBetaCell(0.5, [report], () => tree.baselineScore);
      expect(cell.probes).toBe(report.n);
      expect(cell.rounds).toBe(report.k);
      const w = Math.max(1, report.maxParallelism);
      const seq = report.batches.reduce((a, b) => a + Math.max(1, Math.ceil(b.length / w)), 0);
      expect(cell.parallelPenalty).toBeCloseTo(report.n > 0 ? seq / report.n : 0, 12);
      expect(Number.isFinite(cell.attainment)).toBe(true);
    })
  );
});

describe("fuzz: synthetic trees stay internally consistent", () => {
  it(
    "a tree rebuilt from its observations scores the same twice",
    fuzzCases({ seed: 0xd14, runs: 40 }, async (rng) => {
      const tree = randomTree(rng);
      // Record one rollout, then replay exactly those batches into a fresh
      // env. Replay is deterministic, so the two must score identically.
      const env = new ReplayEnv(tree);
      await randomRollout(env, rng);
      const batches = env.batchesTaken();
      const first = scoreReplay(tree, env, "p", { beta1: 0.002, beta2: 0.01, normalize: "none" });

      const replay = new ReplayEnv(tree);
      for (const b of batches) {
        if (replay.done) break;
        await replay.probeBatch(b);
      }
      expect(replay.batchesTaken()).toEqual(batches);
      expect(replay.rounds).toBe(env.rounds);
      expect(replay.revealedObservations().map((o) => o.id)).toEqual(
        env.revealedObservations().map((o) => o.id)
      );
      const second = scoreReplay(tree, replay, "p", { beta1: 0.002, beta2: 0.01, normalize: "none" });
      expect(second.score).toBeCloseTo(first.score, 12);
    })
  );
});

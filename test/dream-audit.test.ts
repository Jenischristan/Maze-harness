import { describe, expect, it } from "vitest";
import { ReplayEnv } from "../src/env/replay.js";
import { buildFeedbackReport, renderFeedbackMarkdown } from "../src/developer/report.js";
import { computeScore, meanScoreOverGrid, BUDGET_GAMMA } from "../src/score.js";
import { toObservation, withBranchSignals } from "../src/tree.js";
import { planGridForRound, type CycleHistory } from "../src/loop/dream.js";
import type { DiscoveryNode, ExplorationPolicy, Observation } from "../src/types.js";
import { syntheticTree } from "./synthetic.js";

function rootChild(score: number | null): DiscoveryNode {
  return {
    id: "b0a0",
    parentId: "root",
    branch: 0,
    attempt: 0,
    seq: 0,
    score,
    valid: score !== null,
    failClass: score === null ? "runtime" : "ok",
    error: score === null ? "boom" : null,
    diagnostics: null,
    snapshotRef: "ref",
    artifactPath: null,
    cost: { agentCalls: 1, wallMs: 1 },
    createdAt: new Date(0).toISOString()
  };
}

describe("audit: root-child parent delta", () => {
  it("measures deltaVsParent against the baseline when no parent score is given", () => {
    const obs = toObservation(rootChild(1.5), 1, null);
    expect(obs.deltaVsParent).toBeCloseTo(0.5, 12);
    expect(obs.improvedVsParent).toBe(true);

    const worse = toObservation(rootChild(0.5), 1, null);
    expect(worse.deltaVsParent).toBeCloseTo(-0.5, 12);
    expect(worse.improvedVsParent).toBe(false);
  });

  it("an unknown (null) score still yields null deltas", () => {
    const obs = toObservation(rootChild(null), 1, null);
    expect(obs.deltaVsParent).toBeNull();
    expect(obs.improvedVsParent).toBe(false);
  });

  it("branchPromising fires for a root child that beats the baseline", () => {
    const obs = withBranchSignals(toObservation(rootChild(2), 1, null), []);
    expect(obs.branchPromising).toBe(true);
  });
});

describe("audit: opt-in rho budget terms", () => {
  const base = {
    baselineScore: 0,
    revealedScores: [1, 1, 1, 1],
    rounds: 2,
    config: { beta1: 0, beta2: 0, normalize: "none" as const }
  };

  it("omitting rho reproduces the classic objective bit-for-bit", () => {
    expect(computeScore(base).score).toBeCloseTo(1, 12);
  });

  it("rho=0 rewards spending the budget", () => {
    const comp = computeScore({ ...base, config: { ...base.config, rho: 0 } });
    expect(comp.score).toBeCloseTo(1 + BUDGET_GAMMA * 4, 12);
  });

  it("rho=1 rewards reaching the score in fewer rounds", () => {
    const comp = computeScore({ ...base, config: { ...base.config, rho: 1 } });
    expect(comp.score).toBeCloseTo(1 - (BUDGET_GAMMA * 4) / 2, 12);
  });

  it("clamps rho outside [0,1]", () => {
    const hi = computeScore({ ...base, config: { ...base.config, rho: 5 } });
    const one = computeScore({ ...base, config: { ...base.config, rho: 1 } });
    expect(hi.score).toBeCloseTo(one.score, 12);
  });

  it("meanScoreOverGrid varies with the grid it is handed", () => {
    const revealed = [1, 1, 1, 1].map((score, i) =>
      toObservation({ ...rootChild(score), id: `b${i}a0`, branch: i }, 0, null)
    ) as Observation[];
    const report = {
      treeIndex: 0,
      policyId: "p",
      score: 0,
      best: 0,
      n: 4,
      k: 2,
      maxParallelism: 4,
      batches: [["root", "root", "root", "root"]],
      revealed,
      error: null,
      illegal: false,
      timedOut: false,
      wallMs: 0
    };
    const cfg = { beta1: 0, beta2: 0, normalize: "none" as const };
    const low = meanScoreOverGrid([report], cfg, () => 0, [0]);
    const high = meanScoreOverGrid([report], cfg, () => 0, [1]);
    expect(low).toBeGreaterThan(high);
  });
});

describe("audit: feedback components match the selection objective", () => {
  it("includes the lambda width penalty", () => {
    const tree = syntheticTree({
      seed: 3,
      branches: 2,
      refinements: 2,
      maxParallelism: 2,
      roundsLimit: 4
    });
    const report = {
      treeIndex: tree.treeIndex,
      policyId: "p",
      score: 0,
      best: 0,
      n: 4,
      k: 2,
      maxParallelism: 2,
      batches: [
        ["root", "root"],
        ["b0a0", "b1a0"]
      ],
      revealed: [] as Observation[],
      error: null,
      illegal: false,
      timedOut: false,
      wallMs: 0
    };
    const noLambda = buildFeedbackReport(tree, report, {
      beta1: 0,
      beta2: 0,
      normalize: "none"
    });
    const withLambda = buildFeedbackReport(tree, report, {
      beta1: 0,
      beta2: 0,
      normalize: "none",
      lambda: 5
    });

    expect(noLambda.components.penalty).toBeCloseTo(0, 12);
    expect(withLambda.components.penalty).toBeCloseTo(10, 12);
    expect(
      renderFeedbackMarkdown("p", [report], [tree], {
        beta1: 0,
        beta2: 0,
        normalize: "none",
        lambda: 5
      })
    ).toContain("penalty=10.0000");
  });
});

describe("audit: recordless replay world", () => {
  const empty = syntheticTree({
    seed: 1,
    branches: 1,
    refinements: 1,
    maxParallelism: 2,
    roundsLimit: 3
  });
  const recordless = { ...empty, nodes: [] as DiscoveryNode[] };

  it("rejects a root probe instead of consuming a no-op round", async () => {
    const env = new ReplayEnv(recordless, { maxRounds: 3 });
    expect(env.legalRoots()).toBe(0);
    await expect(env.probeBatch(["root"])).rejects.toThrow(/no recorded nodes|no unrevealed root/);
    expect(env.rounds).toBe(0);
    expect(env.observed().size).toBe(0);
  });

  it("an empty batch still terminates the rollout cleanly", async () => {
    const env = new ReplayEnv(recordless, { maxRounds: 3 });
    await env.probeBatch([]);
    expect(env.done).toBe(true);
    expect(env.rounds).toBe(0);
  });
});

describe("audit: next-cycle grid planning reads the real plan history", () => {
  function cycle(opts: {
    treeIndex: number;
    branchCount: number;
    refineCount: number;
    rounds: number;
    beta: number | null;
  }): CycleHistory {
    const tree = syntheticTree({
      seed: opts.treeIndex + 1,
      branches: opts.branchCount,
      refinements: Math.max(1, opts.refineCount + 1),
      maxParallelism: 4,
      roundsLimit: 10
    });
    return {
      tree: { ...tree, treeIndex: opts.treeIndex },
      plan: {
        branchCount: opts.branchCount,
        refineCount: opts.refineCount,
        reason: `plan for cycle ${opts.treeIndex + 1}`
      },
      beta: opts.beta,
      rounds: opts.rounds
    };
  }

  it("passes the planned grid, rounds and beta of each completed cycle", async () => {
    let seen: import("../src/types.js").GridPlanningContext | null = null;
    const policy: ExplorationPolicy = {
      async solve() {},
      planGrid(context) {
        seen = context;
        return { branchCount: 2, refineCount: 1, reason: "echo" };
      }
    };

    const history: CycleHistory[] = [
      cycle({ treeIndex: 0, branchCount: 3, refineCount: 2, rounds: 4, beta: 0.6 }),
      cycle({ treeIndex: 1, branchCount: 1, refineCount: 5, rounds: 2, beta: 0.8 })
    ];
    const { plan, source } = await planGridForRound({
      policy,
      round: 3,
      history,
      caps: { maxBranchCount: 4, maxRefineCount: 6 },
      workerCap: 4
    });

    expect(source).toBe("policy");
    expect(plan).toEqual({ branchCount: 2, refineCount: 1, reason: "echo" });
    expect(seen).not.toBeNull();
    const ctx = seen as unknown as import("../src/types.js").GridPlanningContext;
    expect(ctx.history).toHaveLength(2);

    expect(ctx.history[0]!.plannedBranchCount).toBe(3);
    expect(ctx.history[0]!.plannedRefineCount).toBe(2);
    expect(ctx.history[0]!.rounds).toBe(4);
    expect(ctx.history[0]!.beta).toBe(0.6);
    expect(ctx.history[1]!.plannedBranchCount).toBe(1);
    expect(ctx.history[1]!.plannedRefineCount).toBe(5);
    expect(ctx.history[1]!.rounds).toBe(2);
    expect(ctx.history[1]!.beta).toBe(0.8);
  });

  it("still returns a clamped policy plan and the bootstrap fallback when needed", async () => {
    const throwing: ExplorationPolicy = {
      async solve() {},
      planGrid() {
        throw new Error("boom");
      }
    };
    const fallback = await planGridForRound({
      policy: throwing,
      round: 1,
      history: [],
      caps: { maxBranchCount: 3, maxRefineCount: 2 },
      workerCap: 5
    });
    expect(fallback.source).toBe("fallback");
    expect(fallback.plan.branchCount).toBe(3);
    expect(fallback.plan.refineCount).toBe(2);

    const overreaching: ExplorationPolicy = {
      async solve() {},
      planGrid() {
        return { branchCount: 99, refineCount: 99, reason: "too big" };
      }
    };
    const clamped = await planGridForRound({
      policy: overreaching,
      round: 2,
      history: [],
      caps: { maxBranchCount: 3, maxRefineCount: 2 },
      workerCap: 5
    });
    expect(clamped.source).toBe("policy");
    expect(clamped.plan.branchCount).toBe(3);
    expect(clamped.plan.refineCount).toBe(2);
  });
});

describe("audit: end-to-end multi-round runDream", () => {
  it("plans round 2 from round 1's real plan/beta/rounds", async () => {
    const { runDream } = await import("../src/loop/dream.js");
    const { ScriptedAgent } = await import("../src/agents/scripted.js");
    const { CommandEvaluator } = await import("../src/evaluator.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "dh-dream-e2e-"));
    try {
      const toy = join(process.cwd(), "examples/toy-task");
      const task = {
        name: "toy",
        description: "maximize program.json value",
        prompt: "Increase the value in program.json.",
        initProgramPath: join(toy, "init"),
        evaluatorCommand: ["python3", join(toy, "evaluator/evaluate.py"), "{workspace}"],
        evaluatorTimeoutMs: 20000,
        agentTimeoutMs: 20000
      };

      const seen: Array<import("../src/types.js").GridPlanningContext> = [];
      const source = `
        export default class P {
          constructor(cfg) { this.beta = cfg.beta ?? 0.6; }
          async solve(env) {
            if (env.legalRoots() > 0) await env.probeBatch(["root"]);
            const leaf = env.legalActions().filter((id) => id !== "root")[0];
            if (leaf && env.roundsRemaining > 0) await env.probeBatch([leaf]);
          }
          planGrid(context) {
            globalThis.__seen = (globalThis.__seen || []);
            globalThis.__seen.push(JSON.stringify(context));
            return { branchCount: 1, refineCount: 1, reason: "test-plan" };
          }
        }
      `;

      const { runOfflinePhase } = await import("../src/loop/offline.js");

      void runOfflinePhase;

      const result = await runDream({
        runId: "e2e",
        repoDir: join(dir, "repo"),
        task,
        agent: new ScriptedAgent({ seed: 1, failRate: 0 }),
        evaluator: new CommandEvaluator({
          command: task.evaluatorCommand,
          timeoutMs: task.evaluatorTimeoutMs
        }),
        developer: {
          async revise() {
            return source;
          }
        },
        seedPolicy: { policyId: "fixed", source },
        rounds: 2,
        revisions: 0,
        maxParallelism: 2,
        roundsLimit: 2,
        scoreConfig: { beta1: 0.002, beta2: 0.01, normalize: "none" },
        betaGrid: null,
        initialBeta: 0.6,
        sandbox: { timeoutMs: 20000, memoryMb: 256 },
        runRoot: dir,
        mode: "dream",
        onEvent: (ev) => {
          if (ev.type === "grid-planned") seen.push(ev.plan as never);
        }
      });

      expect(result.rounds).toHaveLength(2);

      expect(seen).toHaveLength(2);

      const { loadLiveManifests } = await import("../src/loop/manifest.js");
      const manifests = await loadLiveManifests(join(dir, "e2e", "reports"));
      expect(manifests).toHaveLength(2);
      expect(manifests[0]!.plannedBranchCount).toBe(1);
      expect(manifests[0]!.plannedRefineCount).toBe(1);
      expect(manifests[0]!.beta).toBe(0.6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

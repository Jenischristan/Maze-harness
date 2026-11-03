import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planGridForRound, runDream } from "../src/loop/dream.js";
import { RunStore } from "../src/runs/store.js";
import { CommandEvaluator } from "../src/evaluator.js";
import { ScriptedAgent } from "../src/agents/scripted.js";
import type { DiscoveryTree, ExplorationPolicy, GridPlan, TaskSpec } from "../src/types.js";

const toy = join(process.cwd(), "examples/toy-task");

const task: TaskSpec = {
  name: "toy",
  description: "maximize value",
  prompt: "increase the value",
  initProgramPath: join(toy, "init"),
  evaluatorCommand: ["python3", join(toy, "evaluator/evaluate.py"), "{workspace}"],
  evaluatorTimeoutMs: 20_000,
  agentTimeoutMs: 20_000
};

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-dreamx-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function historyEntry(
  overrides: Partial<{
    branchCount: number;
    refineCount: number;
    rounds: number;
    beta: number | null;
    nodes: Array<{ branch: number; attempt: number; score: number | null; parentId: string }>;
  }> = {}
) {
  const nodes = (overrides.nodes ?? []).map((n, i) => ({
    id: `n${i}`,
    parentId: n.parentId,
    branch: n.branch,
    attempt: n.attempt,
    seq: i,
    score: n.score,
    valid: true,
    failClass: "ok",
    error: null,
    diagnostics: null,
    snapshotRef: "",
    artifactPath: null,
    cost: { agentCalls: 1, wallMs: 1 },
    createdAt: "t"
  }));
  const tree: DiscoveryTree = {
    runId: "r",
    treeIndex: 0,
    baselineScore: 1,
    maxParallelism: 2,
    roundsLimit: 3,
    policyId: "p",
    createdAt: "t",
    nodes
  };
  return {
    tree,
    plan: {
      branchCount: overrides.branchCount ?? 2,
      refineCount: overrides.refineCount ?? 1,
      reason: "x"
    } as GridPlan,
    beta: overrides.beta ?? null,
    rounds: overrides.rounds ?? 1
  };
}

function policy(planGrid?: (ctx: unknown) => unknown): ExplorationPolicy {
  return {
    async solve() {
      /* plan-only policy */
    },
    ...(planGrid ? { planGrid: planGrid as never } : {})
  };
}

describe("planGridForRound", () => {
  it("falls back when the policy has no planGrid", async () => {
    const out = await planGridForRound({
      policy: policy(),
      round: 1,
      history: [],
      caps: { maxBranchCount: 5, maxRefineCount: 3 },
      workerCap: 2
    });
    expect(out.source).toBe("fallback");
    expect(out.plan.branchCount).toBe(2);
    expect(out.plan.refineCount).toBe(3);
    expect(out.plan.reason).toContain("bootstrap");
  });

  it("uses and clamps a policy plan", async () => {
    const out = await planGridForRound({
      policy: policy(() => ({ branchCount: 99, refineCount: 99, reason: "  wide  " })),
      round: 1,
      history: [],
      caps: { maxBranchCount: 4, maxRefineCount: 2 },
      workerCap: 8
    });
    expect(out.source).toBe("policy");
    expect(out.plan).toEqual({ branchCount: 4, refineCount: 2, reason: "wide" });
  });

  it("floors and clamps degenerate numeric plans", async () => {
    const low = await planGridForRound({
      policy: policy(() => ({ branchCount: -5, refineCount: -5, reason: "" })),
      round: 1,
      history: [],
      caps: { maxBranchCount: 4, maxRefineCount: 2 },
      workerCap: 8
    });
    expect(low.plan.branchCount).toBe(1);
    expect(low.plan.refineCount).toBe(0);
    expect(low.plan.reason).toBe("policy plan (no reason given)");
  });

  it("rejects non-finite and non-object plans", async () => {
    for (const raw of [
      null,
      undefined,
      { branchCount: Number.NaN, refineCount: 1 },
      { branchCount: "x" }
    ]) {
      const out = await planGridForRound({
        policy: policy(() => raw),
        round: 1,
        history: [],
        caps: { maxBranchCount: 3, maxRefineCount: 1 },
        workerCap: 3
      });
      expect(out.source).toBe("fallback");
    }
  });

  it("falls back when planGrid throws", async () => {
    const out = await planGridForRound({
      policy: policy(() => {
        throw new Error("boom");
      }),
      round: 1,
      history: [],
      caps: { maxBranchCount: 3, maxRefineCount: 1 },
      workerCap: 3
    });
    expect(out.source).toBe("fallback");
  });

  it("summarises history into the planning context and emits an event", async () => {
    let seen: unknown = null;
    const events: string[] = [];
    const out = await planGridForRound({
      policy: policy((ctx) => {
        seen = ctx;
        return { branchCount: 1, refineCount: 0, reason: "r" };
      }),
      round: 2,
      history: [
        historyEntry({
          nodes: [
            { branch: 0, attempt: 0, score: 2, parentId: "root" },
            { branch: 0, attempt: 2, score: null, parentId: "n0" }
          ]
        })
      ],
      caps: { maxBranchCount: 3, maxRefineCount: 3 },
      workerCap: 3,
      onEvent: (e) => events.push(e.type)
    });
    const ctx = seen as {
      history: Array<{
        maxAttempt: number;
        probes: number;
        bestScore: number | null;
        rounds: number;
      }>;
      replaySupport: Array<{ traceBranchCount: number; traceRefineCount: number }>;
    };
    expect(ctx.history[0]).toMatchObject({ maxAttempt: 2, probes: 2, bestScore: 2, rounds: 1 });
    expect(ctx.replaySupport[0]).toEqual({ traceBranchCount: 1, traceRefineCount: 2 });
    expect(out.source).toBe("policy");
    expect(events).toEqual(["grid-planned"]);
  });
});

function dreamPolicySource(): string {
  return `
    export default class P {
      async solve(env) {
        if (env.legalRoots() > 0) await env.probeBatch(["root"]);
      }
      planGrid() { return { branchCount: 1, refineCount: 0, reason: "one" }; }
    }
  `;
}

function dreamConfig(runId: string, rounds: number, extra: Record<string, unknown> = {}) {
  return {
    runId,
    repoDir: join(dir, `${runId}-repo`),
    task,
    agent: new ScriptedAgent({ seed: 1, failRate: 0 }),
    evaluator: new CommandEvaluator({
      command: task.evaluatorCommand,
      timeoutMs: task.evaluatorTimeoutMs
    }),
    developer: { revise: async () => dreamPolicySource() },
    seedPolicy: { policyId: "fixed", source: dreamPolicySource() },
    rounds,
    revisions: 0,
    maxParallelism: 1,
    roundsLimit: 1,
    scoreConfig: { beta1: 0.002, beta2: 0.01, normalize: "none" as const },
    betaGrid: null,
    sandbox: { timeoutMs: 20_000, memoryMb: 256 },
    runRoot: dir,
    mode: "fixed" as const,
    ...extra
  };
}

describe("runDream: fixed mode, resume and abort", () => {
  it("runs fixed-mode rounds and records frozen replay scores", async () => {
    const events: string[] = [];
    const res = await runDream(
      dreamConfig("fixed-a", 2, { onEvent: (e: { type: string }) => events.push(e.type) }) as never
    );
    expect(res.rounds).toHaveLength(2);
    expect(res.rounds[0]!.holdoutScore).toBeNull();
    expect(Number.isFinite(res.rounds[0]!.meanScore)).toBe(true);
    expect(events.filter((t) => t === "round-finished")).toHaveLength(2);
    const store = new RunStore({ rootDir: dir, runId: "fixed-a" });
    expect((await store.loadTrees()).length).toBe(2);
    expect(await store.loadState<{ round: number }>()).toMatchObject({ round: 2 });
  }, 180_000);

  it("stops immediately when the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await runDream(dreamConfig("aborted", 2, { signal: ac.signal }) as never);
    expect(res.rounds).toHaveLength(0);
  }, 60_000);

  it("resumes from the last saved round boundary", async () => {
    await runDream(dreamConfig("resume-a", 2) as never);
    const events: Array<{ type: string; round?: number }> = [];
    const res = await runDream(
      dreamConfig("resume-a", 3, {
        onEvent: (e: { type: string; round?: number }) => events.push(e)
      }) as never
    );
    // Round 1 and 2 are reused; only round 3 runs.
    expect(res.rounds).toHaveLength(3);
    const started = events.filter((e) => e.type === "round-started" && e.round !== undefined);
    expect(started.map((e) => e.round)).toEqual([3]);
  }, 240_000);

  it("does nothing to resume when every round already completed", async () => {
    await runDream(dreamConfig("done-a", 1) as never);
    const res = await runDream(dreamConfig("done-a", 1) as never);
    expect(res.rounds).toHaveLength(1);
  }, 180_000);

  it("ignores a corrupt or incomplete saved state", async () => {
    const store = new RunStore({ rootDir: dir, runId: "corrupt" });
    await store.init();
    await writeFile(join(store.dir, "state.json"), JSON.stringify({ round: "nope" }));
    const res = await runDream(dreamConfig("corrupt", 1) as never);
    expect(res.rounds).toHaveLength(1);
  }, 120_000);

  it("starts over when the archived trees disagree with the state", async () => {
    const store = new RunStore({ rootDir: dir, runId: "mismatch" });
    await store.init();
    await mkdir(join(store.dir, "trees"), { recursive: true });
    await writeFile(
      join(store.dir, "state.json"),
      JSON.stringify({
        round: 2,
        policyId: "fixed",
        policySource: dreamPolicySource(),
        cumulativeCalls: 3,
        results: []
      })
    );
    const res = await runDream(dreamConfig("mismatch", 3) as never);
    expect(res.rounds.length).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it("throws when the seed policy does not compile", async () => {
    await expect(
      runDream(
        dreamConfig("bad-policy", 1, {
          seedPolicy: { policyId: "bad", source: "export default 5;" }
        }) as never
      )
    ).rejects.toThrow(/failed to compile/);
  }, 60_000);
});

describe("runDream: dream mode with a failing developer", () => {
  it("records revision failures without aborting the run", async () => {
    const events: Array<{ type: string }> = [];
    const res = await runDream({
      ...dreamConfig("dream-fail", 1),
      mode: "dream" as const,
      revisions: 1,
      developer: {
        revise: async () => {
          throw new Error("developer down");
        }
      },
      onEvent: (e: { type: string }) => {
        events.push(e);
        if (e.type === "offline") {
          const inner = (e as unknown as { event: { type: string } }).event;
          events.push(inner as never);
        }
      }
    } as never);
    expect(res.rounds).toHaveLength(1);
    expect(events.some((e) => e.type === "revision-finished")).toBe(true);
  }, 240_000);
});

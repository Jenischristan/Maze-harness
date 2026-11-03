import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { GitWorkspace } from "../src/workspace/git.js";
import { LiveEnv } from "../src/env/live.js";
import type { DiscoveryAgent, Evaluator, TaskSpec } from "../src/types.js";
import { makeTempDir } from "./helpers/fixtures.js";

const toyTask = join(process.cwd(), "examples/toy-task");

const task: TaskSpec = {
  name: "toy",
  description: "maximize value",
  prompt: "increase the value",
  initProgramPath: join(toyTask, "init"),
  evaluatorCommand: ["python3", join(toyTask, "evaluator/evaluate.py"), "{workspace}"],
  evaluatorTimeoutMs: 20_000,
  agentTimeoutMs: 20_000
};

let tmp = "";
let ws: GitWorkspace;
let cleanup = async (): Promise<void> => undefined;

beforeEach(async () => {
  const t = await makeTempDir("dh-livex");
  tmp = t.dir;
  cleanup = t.remove;
  ws = new GitWorkspace({
    repoDir: join(tmp, "repo"),
    worktreesDir: join(tmp, "repo", "worktrees"),
    initProgramDir: task.initProgramPath
  });
  await ws.init();
});

afterEach(async () => {
  await cleanup();
});

const okAgent: DiscoveryAgent = { run: async () => ({ tokens: 7 }) };

function evaluatorReturning(score: number | null, delayMs = 0): Evaluator {
  return {
    evaluate: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return {
        score,
        valid: score !== null,
        failClass: score === null ? "incorrect" : "ok",
        error: null,
        diagnostics: null
      };
    }
  };
}

function env(
  opts: {
    agent?: DiscoveryAgent;
    evaluator?: Evaluator;
    maxParallelism?: number;
    roundsLimit?: number;
    plan?: { branchCount: number; refineCount: number; reason?: string };
    signal?: AbortSignal;
  } = {}
): LiveEnv {
  return new LiveEnv({
    runId: "t",
    treeIndex: 0,
    baselineScore: 1,
    maxParallelism: opts.maxParallelism ?? 3,
    roundsLimit: opts.roundsLimit ?? 4,
    policyId: "p",
    task,
    agent: opts.agent ?? okAgent,
    evaluator: opts.evaluator ?? evaluatorReturning(2),
    workspace: ws,
    priorHistory: [],
    gridPlan: opts.plan ? { ...opts.plan, reason: "test plan" } : undefined,
    signal: opts.signal
  });
}

describe("LiveEnv: batch validation", () => {
  it("starts with roots available and no observations", () => {
    const e = env();
    expect(e.legalRoots()).toBeGreaterThan(0);
    expect(e.legalActions()).toContain("root");
    expect(e.observed().size).toBe(0);
    expect(e.bestSoFar).toBe(1);
    expect(e.budgetSpent).toBe(0);
    expect(e.roundsRemaining).toBe(4);
    expect(e.done).toBe(false);
    expect(e.meta("root").tags).toEqual(["root"]);
    expect(e.meta("missing").branch).toBe(-1);
  });

  it("rejects a non-eligible id", async () => {
    await expect(env().probeBatch(["nope"])).rejects.toThrow(/non-eligible/);
  });

  it("rejects a duplicate leaf", async () => {
    const e = env();
    const [root] = await e.probeBatch(["root"]);
    await expect(e.probeBatch([root!.id, root!.id])).rejects.toThrow(/duplicate leaf/);
  });

  it("rejects a batch larger than maxParallelism", async () => {
    await expect(env({ maxParallelism: 1 }).probeBatch(["root", "root"])).rejects.toThrow(
      /maxParallelism/
    );
  });

  it("rejects a batch that exceeds the plan refine cap", async () => {
    const e = env({ plan: { branchCount: 2, refineCount: 0 } });
    const [root] = await e.probeBatch(["root"]);
    await expect(e.probeBatch([root!.id])).rejects.toThrow(/refine cap/);
  });

  it("rejects opening more roots than the plan allows", async () => {
    const e = env({ plan: { branchCount: 1, refineCount: 1 } });
    await expect(e.probeBatch(["root", "root"])).rejects.toThrow(/plan allows/);
  });

  it("throws and marks done when the signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const e = env({ signal: ac.signal });
    await expect(e.probeBatch(["root"])).rejects.toThrow(/aborted/);
    expect(e.done).toBe(true);
  });

  it("treats an empty batch as completion", async () => {
    const e = env();
    expect(await e.probeBatch([])).toEqual([]);
    expect(e.done).toBe(true);
    expect(e.legalActions()).toEqual([]);
  });
});

describe("LiveEnv: probing", () => {
  it("records a scored observation and advances the round", async () => {
    const e = env();
    const [obs] = await e.probeBatch(["root"]);
    expect(obs!.score).toBe(2);
    expect(obs!.valid).toBe(true);
    expect(obs!.branchPromising).toBe(true);
    expect(e.observed().size).toBe(1);
    expect(e.bestSoFar).toBe(2);
    expect(e.rounds).toBe(1);
    expect(e.calls).toBe(1);
    expect(e.tree.nodes).toHaveLength(1);
    expect(e.summary().nodeCount).toBe(1);
    // With no grid plan the root count is unbounded.
    expect(e.legalRoots()).toBe(Infinity);
  });

  it("classifies an agent timeout", async () => {
    const slow: DiscoveryAgent = {
      run: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return {};
      }
    };
    const e = new LiveEnv({
      runId: "t",
      treeIndex: 0,
      baselineScore: 1,
      maxParallelism: 1,
      roundsLimit: 1,
      policyId: "p",
      task: { ...task, agentTimeoutMs: 20 },
      agent: slow,
      evaluator: evaluatorReturning(2),
      workspace: ws,
      priorHistory: []
    });
    const [obs] = await e.probeBatch(["root"]);
    expect(obs!.failClass).toBe("timeout");
    expect(obs!.valid).toBe(false);
  }, 30_000);

  it("classifies an agent error", async () => {
    const broken: DiscoveryAgent = {
      run: async () => {
        throw new Error("agent exploded");
      }
    };
    const e = env({ agent: broken });
    const [obs] = await e.probeBatch(["root"]);
    expect(obs!.failClass).toBe("agent_error");
    expect(obs!.error).toContain("agent exploded");
  });

  it("refines an existing leaf with its ancestor path", async () => {
    const e = env();
    const [root] = await e.probeBatch(["root"]);
    const [child] = await e.probeBatch([root!.id]);
    expect(child!.parentId).toBe(root!.id);
    expect(child!.branch).toBe(root!.branch);
    expect(child!.attempt).toBe(1);
    expect(e.tree.nodes).toHaveLength(2);
  });

  it("reset clears observations and rounds", async () => {
    const e = env();
    await e.probeBatch(["root"]);
    e.reset();
    expect(e.observed().size).toBe(0);
    expect(e.rounds).toBe(0);
    expect(e.done).toBe(false);
    expect(e.roundsRemaining).toBe(4);
  });
});

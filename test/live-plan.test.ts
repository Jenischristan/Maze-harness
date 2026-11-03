import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorkspace } from "../src/workspace/git.js";
import { LiveEnv } from "../src/env/live.js";
import { CommandEvaluator } from "../src/evaluator.js";
import { ScriptedAgent } from "../src/agents/scripted.js";
import { ROOT_ID } from "../src/tree.js";
import type { ExplorationPolicy, TaskSpec } from "../src/types.js";

const repoRoot = process.cwd();
const toyTask = join(repoRoot, "examples/toy-task");

const task: TaskSpec = {
  name: "toy",
  description: "maximize program.json value",
  prompt: "Increase the value in program.json.",
  initProgramPath: join(toyTask, "init"),
  evaluatorCommand: ["python3", join(toyTask, "evaluator/evaluate.py"), "{workspace}"],
  evaluatorTimeoutMs: 20000,
  agentTimeoutMs: 20000
};

let tmp = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dh-plan-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function makeEnv(plan: { branchCount: number; refineCount: number }) {
  const ws = new GitWorkspace({
    repoDir: join(tmp, "repo"),
    worktreesDir: join(tmp, "repo", "worktrees"),
    initProgramDir: task.initProgramPath
  });
  await ws.init();
  const evaluator = new CommandEvaluator({
    command: task.evaluatorCommand,
    timeoutMs: task.evaluatorTimeoutMs
  });
  const rootRef = await ws.rootSnapshotRef();
  const rootDir = await ws.createWorktree("baseline", rootRef);
  const baseline = await evaluator.evaluate(rootDir);
  await ws.removeWorktree(rootDir);
  return new LiveEnv({
    runId: "plan",
    treeIndex: 0,
    baselineScore: baseline.score ?? 0,
    maxParallelism: 4,
    roundsLimit: 10,
    policyId: "plan",
    task,
    agent: new ScriptedAgent({ seed: 1, failRate: 0 }),
    evaluator,
    workspace: ws,
    priorHistory: [],
    gridPlan: { branchCount: plan.branchCount, refineCount: plan.refineCount, reason: "test" }
  });
}

describe("live grid plan is a hard bound", () => {
  it("rejects opening more roots than the plan allows", async () => {
    const env = await makeEnv({ branchCount: 2, refineCount: 2 });
    await expect(env.probeBatch([ROOT_ID, ROOT_ID, ROOT_ID])).rejects.toThrow(/plan allows 2/);
    const opened = await env.probeBatch([ROOT_ID, ROOT_ID]);
    expect(opened).toHaveLength(2);
  });

  it("rejects refining a leaf that is already at the refine cap", async () => {
    const env = await makeEnv({ branchCount: 1, refineCount: 1 });
    const [root] = await env.probeBatch([ROOT_ID]);
    const [refined] = await env.probeBatch([root!.id]);
    expect(refined!.attempt).toBe(1);
    await expect(env.probeBatch([refined!.id])).rejects.toThrow(/refine cap 1/);
  });

  it("a compliant policy finishes without tripping the bound", async () => {
    const env = await makeEnv({ branchCount: 2, refineCount: 1 });
    const policy: ExplorationPolicy = {
      async solve(e) {
        // Open the two planned roots, then refine both leaves in one batch.
        const roots = await e.probeBatch([ROOT_ID, ROOT_ID]);
        await e.probeBatch(roots.map((r) => r.id));
      }
    };
    await policy.solve(env);
    // Batch 1 opens the two planned roots; batch 2 refines both leaves once.
    expect(env.rounds).toBe(2);
    const nodes = env.currentTree().nodes;
    expect(nodes.filter((n) => n.parentId === ROOT_ID)).toHaveLength(2);
    for (const root of nodes.filter((n) => n.parentId === ROOT_ID)) {
      expect(nodes.filter((n) => n.parentId === root.id)).toHaveLength(1);
    }
  });
});

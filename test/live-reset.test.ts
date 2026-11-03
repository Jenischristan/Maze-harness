import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorkspace } from "../src/workspace/git.js";
import { LiveEnv } from "../src/env/live.js";
import { CommandEvaluator } from "../src/evaluator.js";
import { ScriptedAgent } from "../src/agents/scripted.js";
import { ROOT_ID } from "../src/tree.js";
import type { TaskSpec } from "../src/types.js";

const toyTask = join(process.cwd(), "examples/toy-task");

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
  tmp = await mkdtemp(join(tmpdir(), "dh-live-reset-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("live reset keeps the recorded tree", () => {
  it("clears the observed prefix but preserves produced nodes", async () => {
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

    const env = new LiveEnv({
      runId: "live-reset",
      treeIndex: 0,
      baselineScore: baseline.score ?? 0,
      maxParallelism: 2,
      roundsLimit: 4,
      policyId: "p",
      task,
      agent: new ScriptedAgent({ seed: 1, failRate: 0 }),
      evaluator,
      workspace: ws,
      priorHistory: []
    });

    const [a] = await env.probeBatch([ROOT_ID]);
    expect(a).toBeDefined();
    expect(env.currentTree().nodes).toHaveLength(1);

    env.reset();
    expect(env.observed().size).toBe(0);
    expect(env.rounds).toBe(0);
    expect(env.legalActions()).toEqual([ROOT_ID]);
    // The discovery output survives a prefix reset.
    expect(env.currentTree().nodes).toHaveLength(1);
    expect(env.currentTree().nodes[0]!.id).toBe(a!.id);

    // A new probe after reset appends and never collides with the old id.
    const [b] = await env.probeBatch([ROOT_ID]);
    expect(b).toBeDefined();
    expect(b!.id).not.toBe(a!.id);
    expect(env.currentTree().nodes).toHaveLength(2);
  }, 60000);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorkspace } from "../src/workspace/git.js";
import { LiveEnv } from "../src/env/live.js";
import { ReplayEnv } from "../src/env/replay.js";
import { CommandEvaluator } from "../src/evaluator.js";
import { ScriptedAgent } from "../src/agents/scripted.js";
import { FixedParallelRefine } from "../src/policies/fixedParallelRefine.js";
import { runOnlineRollout } from "../src/loop/online.js";
import { scoreReplay, DEFAULT_SCORE_CONFIG } from "../src/score.js";
import type { DiscoveryTree, TaskSpec } from "../src/types.js";

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
  tmp = await mkdtemp(join(tmpdir(), "dh-live-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<GitWorkspace> {
  const ws = new GitWorkspace({
    repoDir: join(tmp, "repo"),
    worktreesDir: join(tmp, "repo", "worktrees"),
    initProgramDir: task.initProgramPath
  });
  await ws.init();
  return ws;
}

async function rollout(opts: { seed?: number; roundsLimit?: number } = {}) {
  const ws = await makeWorkspace();
  const evaluator = new CommandEvaluator({
    command: task.evaluatorCommand,
    timeoutMs: task.evaluatorTimeoutMs
  });
  const agent = new ScriptedAgent({ seed: opts.seed ?? 3, failRate: 0 });
  const rootRef = await ws.rootSnapshotRef();
  const rootDir = await ws.createWorktree("baseline", rootRef);
  const baseline = await evaluator.evaluate(rootDir);
  await ws.removeWorktree(rootDir);
  const env = new LiveEnv({
    runId: "test",
    treeIndex: 0,
    baselineScore: baseline.score ?? 0,
    maxParallelism: 3,
    roundsLimit: opts.roundsLimit ?? 4,
    policyId: "fixed",
    task,
    agent,
    evaluator,
    workspace: ws,
    priorHistory: []
  });
  await runOnlineRollout(env, new FixedParallelRefine({ branches: 3, refinements: 2 }));
  return { env, ws, baseline: baseline.score ?? 0 };
}

describe("live path", () => {
  it("produces a tree that ReplayEnv can replay", async () => {
    const { env } = await rollout();
    const tree = env.currentTree();
    expect(tree.nodes.length).toBeGreaterThan(0);
    expect(new Set(tree.nodes.map((n) => n.branch)).size).toBeGreaterThan(0);
    for (const node of tree.nodes) {
      if (node.parentId !== "root") {
        expect(tree.nodes.find((n) => n.id === node.parentId)).toBeDefined();
      }
      expect(node.snapshotRef).toMatch(/^[0-9a-f]{40}$/);
      expect(node.failClass).toBe("ok");
    }
    const replay = new ReplayEnv(tree, { maxRounds: tree.roundsLimit });
    await replay.probeBatch(["root", "root", "root"]);
    const leaves = replay.legalActions().filter((id) => id !== "root");
    expect(leaves.length).toBeGreaterThan(0);
    await replay.probeBatch(leaves.slice(0, 2));
    expect(replay.revealedObservations().length).toBeGreaterThan(0);
  });

  it("replaying the recorded decisions reproduces recorded scores", async () => {
    const { env } = await rollout({ seed: 9, roundsLimit: 3 });
    const tree = env.currentTree();
    const replay = new ReplayEnv(tree, { maxRounds: tree.roundsLimit });
    for (const batch of env.batchesTaken()) {
      await replay.probeBatch(batch);
    }
    expect(replay.batchesTaken()).toEqual(env.batchesTaken());
    const recorded = new Map(tree.nodes.map((n) => [n.id, n.score]));
    for (const obs of replay.revealedObservations()) {
      expect(obs.score).toBe(recorded.get(obs.id) ?? null);
    }
    const a = scoreReplay(tree, replay, "fixed", DEFAULT_SCORE_CONFIG);
    const replay2 = new ReplayEnv(tree, { maxRounds: tree.roundsLimit });
    for (const batch of env.batchesTaken()) await replay2.probeBatch(batch);
    const b = scoreReplay(tree, replay2, "fixed", DEFAULT_SCORE_CONFIG);
    expect(a.score).toBe(b.score);
  });

  it("a live rollout is resumable from the on-disk tree", async () => {
    const { env, ws } = await rollout({ seed: 4, roundsLimit: 2 });
    const tree = env.currentTree();
    const again = await ws.createWorktree("resume-check", tree.nodes[0]!.snapshotRef);
    const evaluator = new CommandEvaluator({
      command: task.evaluatorCommand,
      timeoutMs: task.evaluatorTimeoutMs
    });
    const res = await evaluator.evaluate(again);
    expect(res.score).toBe(tree.nodes[0]!.score);
    await ws.removeWorktree(again);
  });
});

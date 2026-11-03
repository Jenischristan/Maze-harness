import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { loadBetaSweep, loadLiveManifests, saveLiveManifest } from "../src/loop/manifest.js";
import { ToolExecutor, ToolRegistry } from "../src/tools/index.js";

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

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-merged-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

describe("manifest loaders", () => {
  it("returns null for a missing beta sweep", async () => {
    expect(await loadBetaSweep(dir, 1, "p")).toBeNull();
  });

  it("loads a beta sweep with defaults for missing fields", async () => {
    await writeFile(
      join(dir, "t0001-p-beta_sweep.json"),
      JSON.stringify({ cells: [{ beta: 0.2, attainment: 1, probes: 2 }] })
    );
    const sweep = await loadBetaSweep(dir, 1, "p");
    expect(sweep![0]).toMatchObject({ beta: 0.2, auc: 0, paretoReward: 0.5 });
  });

  it("returns null for a corrupt beta sweep", async () => {
    await writeFile(join(dir, "t0001-p-beta_sweep.json"), "{nope");
    expect(await loadBetaSweep(dir, 1, "p")).toBeNull();
  });

  it("loads saved manifests sorted by round", async () => {
    const make = (round: number) =>
      ({
        round,
        policyId: "p",
        beta: 0,
        treeIndex: round,
        createdAt: "t"
      }) as never;
    await saveLiveManifest(dir, make(2));
    await saveLiveManifest(dir, make(1));
    const manifests = await loadLiveManifests(dir);
    expect(manifests.map((m) => m.round)).toEqual([1, 2]);
  });

  it("returns no manifests when the directory is missing", async () => {
    expect(await loadLiveManifests(join(dir, "none"))).toEqual([]);
  });
});

describe("ToolExecutor abort and validation", () => {
  function executor(): ToolExecutor {
    return new ToolExecutor({
      registry: new ToolRegistry(),
      workspaceDir: dir,
      permission: { defaultAction: "allow", rules: [] },
      hooks: { register: () => undefined, list: () => [], runAll: async () => [] }
    });
  }

  it("returns aborted results for every call when pre-aborted", async () => {
    const ex = executor();
    const ac = new AbortController();
    ac.abort();
    ex.setSignal(ac.signal);
    const batch = await ex.runBatch([{ id: "a", name: "read", arguments: { path: "x" } }]);
    expect(batch.results[0]).toMatchObject({ ok: false, error: "aborted" });
  });

  it("reports unknown tools and invalid arguments without throwing", async () => {
    const batch = await executor().runBatch([
      { id: "a", name: "nope", arguments: {} },
      { id: "b", name: "read", arguments: {} }
    ]);
    expect(batch.results[0]!.error).toBe("unknown-tool");
    expect(batch.results[1]!.error).toBe("invalid-arguments");
  });

  it("wraps a throwing tool in an error result", async () => {
    const registry = new ToolRegistry([
      {
        name: "boom",
        description: "",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          throw new Error("explode");
        }
      }
    ]);
    const ex = new ToolExecutor({
      registry,
      workspaceDir: dir,
      permission: { defaultAction: "allow", rules: [] },
      hooks: { register: () => undefined, list: () => [], runAll: async () => [] }
    });
    const batch = await ex.runBatch([{ id: "a", name: "boom", arguments: {} }]);
    expect(batch.results[0]!.content).toContain("explode");
    expect(batch.results[0]!.ok).toBe(false);
  });

  it("runs verification hooks only after a successful mutation", async () => {
    let runs = 0;
    const registry = new ToolRegistry([
      {
        name: "mut",
        description: "",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ callId: "", name: "mut", ok: true, content: "" })
      }
    ]);
    const ex = new ToolExecutor({
      registry,
      workspaceDir: dir,
      permission: { defaultAction: "allow", rules: [] },
      hooks: {
        register: () => undefined,
        list: () => [{ name: "h", command: "true" }],
        runAll: async () => {
          runs += 1;
          return [];
        }
      }
    });
    await ex.runBatch([{ id: "a", name: "mut", arguments: {} }]);
    expect(runs).toBe(1);
    await ex.runBatch([{ id: "b", name: "nope", arguments: {} }]);
    expect(runs).toBe(1);
  });

  it("exposes a context sharing the read/modified sets", async () => {
    const ex = executor();
    ex.readFiles.add("x");
    ex.modifiedFiles.add("y");
    const ctx = ex.context();
    expect(ctx.readFiles.has("x")).toBe(true);
    expect(ctx.modifiedFiles.has("y")).toBe(true);
    expect(ctx.maxOutputBytes).toBeGreaterThan(0);
  });

  it("returns the registry schema and supports replacement", async () => {
    const registry = new ToolRegistry([]);
    expect(registry.schema()).toEqual([]);
    registry.register({
      name: "t",
      description: "d",
      parameters: { type: "object" },
      execute: async () => ({ callId: "", name: "t", ok: true, content: "" })
    });
    expect(registry.schema()[0]).toMatchObject({ type: "function", function: { name: "t" } });
    expect(registry.list()).toHaveLength(1);
  });
});

describe("subagent helpers", () => {
  it("finds a subagent by exact name, prefix, or not at all", async () => {
    const { findSubAgent, SUBAGENTS, specFromDefinition } = await import("../src/subagents.js");
    expect(findSubAgent("explore")!.name).toBe("explore");
    expect(findSubAgent("  EXPLORE ")!.name).toBe("explore");
    expect(findSubAgent("expl")!.name).toBe("explore");
    expect(findSubAgent("")).toBeNull();
    expect(findSubAgent("zzz")).toBeNull();
    expect(SUBAGENTS.some((s) => s.name === "verify")).toBe(true);
    const spec = specFromDefinition({
      name: "custom",
      description: "d",
      prompt: "p",
      mode: "subagent",
      source: "file",
      tools: ["read"],
      maxTurns: 3,
      model: "m",
      readOnly: true
    } as never);
    expect(spec).toMatchObject({ name: "custom", maxTurns: 3, readOnly: true });
  });

  it("delegate rejects unknown agents and empty tasks", async () => {
    const { subAgentTool } = await import("../src/subagents.js");
    const tool = subAgentTool({
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k"
    });
    expect((await tool.execute({ agent: "nope", task: "x" }, {} as never)).error).toBe(
      "unknown-subagent"
    );
    expect((await tool.execute({ agent: "explore", task: "  " }, {} as never)).error).toBe(
      "no-task"
    );
    expect(tool.description).toContain("explore");
  });
});

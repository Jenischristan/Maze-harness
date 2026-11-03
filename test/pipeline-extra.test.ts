import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandEvaluator } from "../src/evaluator.js";
import { RunStore } from "../src/runs/store.js";
import { ToolExecutor, ToolRegistry } from "../src/tools/index.js";
import { isMutatingTool, isReadOnlyTool, READ_ONLY_TOOL_NAMES } from "../src/tools/kinds.js";
import { loadBetaSweep, loadLiveManifests, saveLiveManifest } from "../src/loop/manifest.js";
import type { DiscoveryTree, PolicyVersionRecord, ReplayReport } from "../src/types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-pipe-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function tree(index = 0): Promise<DiscoveryTree> {
  return {
    runId: "r",
    treeIndex: index,
    baselineScore: 1,
    maxParallelism: 2,
    roundsLimit: 3,
    policyId: "p",
    createdAt: "t",
    nodes: []
  };
}

describe("evaluator: command results", () => {
  function evaluator(script: string, timeoutMs = 10_000): CommandEvaluator {
    return new CommandEvaluator({
      command: [process.execPath, "-e", script],
      timeoutMs,
      cwd: dir
    });
  }

  it("parses a score/valid JSON payload", async () => {
    const res = await evaluator("console.log(JSON.stringify({score: 0.5, valid: true}))").evaluate(
      dir
    );
    expect(res).toMatchObject({ score: 0.5, valid: true, failClass: "ok" });
  });

  it("defaults validity from the score and failClass from validity", async () => {
    const ok = await evaluator("console.log(JSON.stringify({score: 1}))").evaluate(dir);
    expect(ok.valid).toBe(true);
    const bad = await evaluator("console.log(JSON.stringify({score: null}))").evaluate(dir);
    expect(bad.valid).toBe(false);
    expect(bad.failClass).toBe("incorrect");
  });

  it("keeps an explicit failClass and error", async () => {
    const res = await evaluator(
      'console.log(JSON.stringify({score: null, failClass: "compile", error: "nope"}))'
    ).evaluate(dir);
    expect(res).toMatchObject({ failClass: "compile", error: "nope" });
  });

  it("rejects a non-object payload", async () => {
    const res = await evaluator('console.log("[1,2]")').evaluate(dir);
    expect(res.error).toBe("evaluator JSON must be an object");
  });

  it("rejects a non-JSON last line", async () => {
    const res = await evaluator('console.log("not json")').evaluate(dir);
    expect(res.error).toBe("evaluator last line is not JSON");
  });

  it("reports no JSON line with the exit class", async () => {
    const res = await evaluator("process.exit(3)").evaluate(dir);
    expect(res.failClass).toBe("runtime");
    expect(res.error).toMatch(/no JSON line/);
  });

  it("times out a slow evaluator", async () => {
    const res = await evaluator("setTimeout(() => {}, 5000)", 200).evaluate(dir);
    expect(res.failClass).toBe("timeout");
  });

  it("reports an abort", async () => {
    const ac = new AbortController();
    const p = evaluator("setTimeout(() => {}, 5000)", 10_000).evaluate(dir, ac.signal);
    setTimeout(() => ac.abort(), 50);
    expect((await p).error).toBe("evaluator aborted");
  });

  it("rejects an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await evaluator("console.log('{}')").evaluate(dir, ac.signal);
    expect(res.failClass).toBe("timeout");
  });

  it("reports an empty command", async () => {
    const res = await new CommandEvaluator({ command: [], timeoutMs: 1000 }).evaluate(dir);
    expect(res.error).toBe("evaluator command is empty");
  });

  it("reports a spawn failure", async () => {
    const res = await new CommandEvaluator({
      command: [join(dir, "no-such-binary")],
      timeoutMs: 1000
    }).evaluate(dir);
    expect(res.error).toMatch(/spawn failed/);
  });

  it("substitutes {workspace} in arguments", async () => {
    const res = await new CommandEvaluator({
      command: [process.execPath, "-e", "console.log(JSON.stringify({score:1, valid:true}))"],
      timeoutMs: 5000
    }).evaluate("{workspace}");
    expect(res.score).toBe(1);
  });
});

describe("RunStore", () => {
  it("saves and loads trees sorted by index", async () => {
    const store = new RunStore({ rootDir: dir, runId: "r" });
    await store.saveTree(await tree(1));
    await store.saveTree(await tree(0));
    const trees = await store.loadTrees();
    expect(trees.map((t) => t.treeIndex)).toEqual([0, 1]);
  });

  it("returns no trees when the directory is absent", async () => {
    const store = new RunStore({ rootDir: dir, runId: "none" });
    expect(await store.loadTrees()).toEqual([]);
  });

  it("saves a policy version as source and JSON", async () => {
    const store = new RunStore({ rootDir: dir, runId: "r" });
    const record: PolicyVersionRecord = {
      policyId: "p",
      source: "class X {}",
      meanScore: 1,
      scores: [1],
      selected: true,
      createdAt: "t"
    };
    await store.savePolicyVersion(2, record);
    const base = join(dir, "r", "policies", "t0002-p");
    expect(await readFile(`${base}.ts`, "utf8")).toBe("class X {}");
    expect(JSON.parse(await readFile(`${base}.json`, "utf8")).policyId).toBe("p");
  });

  it("saves replay reports", async () => {
    const store = new RunStore({ rootDir: dir, runId: "r" });
    const reports = [{ treeIndex: 0 }] as unknown as ReplayReport[];
    await store.saveReplayReports(1, "p", reports);
    const raw = JSON.parse(await readFile(join(dir, "r", "reports", "t0001-p.json"), "utf8"));
    expect(raw).toHaveLength(1);
  });

  it("round-trips state and returns null when absent", async () => {
    const store = new RunStore({ rootDir: dir, runId: "r" });
    expect(await store.loadState()).toBeNull();
    await store.saveState({ round: 3 });
    expect(await store.loadState()).toEqual({ round: 3 });
  });
});

describe("tools/kinds", () => {
  it("classifies read-only and mutating tools", () => {
    expect(isReadOnlyTool("read")).toBe(true);
    expect(isReadOnlyTool("edit")).toBe(false);
    expect(isMutatingTool("bash")).toBe(true);
    expect(isMutatingTool("read")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES).toContain("grep");
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

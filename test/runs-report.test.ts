import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRuns, readRun } from "../src/runs/report.js";
import { RunStore } from "../src/runs/store.js";
import type { DiscoveryTree, PolicyVersionRecord, ReplayReport } from "../src/types.js";

let tmp = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dh-report-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeState(
  runId: string,
  state: Record<string, unknown>,
  trees: Array<{ score: number | null }> = []
): Promise<void> {
  const dir = join(tmp, runId);
  await mkdir(join(dir, "trees"), { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
  for (const [i, node] of trees.entries()) {
    await writeFile(
      join(dir, "trees", `tree-${String(i).padStart(4, "0")}.json`),
      JSON.stringify({
        runId,
        treeIndex: i,
        baselineScore: 0,
        maxParallelism: 2,
        roundsLimit: 2,
        policyId: "p",
        nodes: [
          {
            id: "b0a0",
            parentId: "root",
            branch: 0,
            attempt: 0,
            seq: 0,
            score: node.score,
            valid: node.score !== null,
            failClass: node.score === null ? "runtime" : "ok",
            error: null,
            diagnostics: null,
            snapshotRef: "ref",
            artifactPath: null,
            cost: { agentCalls: 1, wallMs: 1 },
            createdAt: new Date(0).toISOString()
          }
        ],
        createdAt: new Date(0).toISOString()
      }),
      "utf8"
    );
  }
}

const results = [{ round: 1, meanScore: 0.5, cumulativeCalls: 4, treeIndex: 0 }];

describe("report discovers runs by state, not by name", () => {
  it("lists a run with a custom id", async () => {
    await writeState("e2e", { runId: "e2e", round: 1, mode: "fixed", results }, [{ score: 1.5 }]);
    const runs = await listRuns(tmp);
    expect(runs.map((r) => r.runId)).toEqual(["e2e"]);
    expect(runs[0]!.mode).toBe("fixed");
    expect(runs[0]!.bestScore).toBe(1.5);
    expect(runs[0]!.totalCalls).toBe(4);
  });

  it("classifies by the recorded mode, not the id prefix", async () => {
    await writeState("exp-1", { runId: "exp-1", round: 1, mode: "dream", results });
    const run = await readRun(tmp, "exp-1");
    expect(run?.mode).toBe("dream");
  });

  it("falls back to the name prefix for legacy state with no mode", async () => {
    await writeState("dream-legacy", { runId: "dream-legacy", round: 1, results });
    await writeState("fixed-legacy", { runId: "fixed-legacy", round: 1, results });
    expect((await readRun(tmp, "dream-legacy"))?.mode).toBe("dream");
    expect((await readRun(tmp, "fixed-legacy"))?.mode).toBe("fixed");
  });

  it("ignores directories without a state file and missing roots", async () => {
    await mkdir(join(tmp, "not-a-run"), { recursive: true });
    expect(await listRuns(tmp)).toEqual([]);
    expect(await listRuns(join(tmp, "does-not-exist"))).toEqual([]);
  });
});

async function tree(index: number): Promise<DiscoveryTree> {
  return {
    runId: "r",
    treeIndex: index,
    baselineScore: 1,
    maxParallelism: 2,
    roundsLimit: 2,
    policyId: "p",
    createdAt: "t",
    nodes: []
  };
}

describe("RunStore", () => {
  it("saves and loads trees sorted by index", async () => {
    const store = new RunStore({ rootDir: tmp, runId: "r" });
    await store.saveTree(await tree(1));
    await store.saveTree(await tree(0));
    const trees = await store.loadTrees();
    expect(trees.map((t) => t.treeIndex)).toEqual([0, 1]);
  });

  it("returns no trees when the directory is absent", async () => {
    const store = new RunStore({ rootDir: tmp, runId: "none" });
    expect(await store.loadTrees()).toEqual([]);
  });

  it("saves a policy version as source and JSON", async () => {
    const store = new RunStore({ rootDir: tmp, runId: "r" });
    const record: PolicyVersionRecord = {
      policyId: "p",
      source: "class X {}",
      meanScore: 1,
      scores: [1],
      selected: true,
      createdAt: "t"
    };
    await store.savePolicyVersion(2, record);
    const base = join(tmp, "r", "policies", "t0002-p");
    expect(await readFile(`${base}.ts`, "utf8")).toBe("class X {}");
    expect(JSON.parse(await readFile(`${base}.json`, "utf8")).policyId).toBe("p");
  });

  it("saves replay reports", async () => {
    const store = new RunStore({ rootDir: tmp, runId: "r" });
    const reports = [{ treeIndex: 0 }] as unknown as ReplayReport[];
    await store.saveReplayReports(1, "p", reports);
    const raw = JSON.parse(await readFile(join(tmp, "r", "reports", "t0001-p.json"), "utf8"));
    expect(raw).toHaveLength(1);
  });

  it("round-trips state and returns null when absent", async () => {
    const store = new RunStore({ rootDir: tmp, runId: "r" });
    expect(await store.loadState()).toBeNull();
    await store.saveState({ round: 3 });
    expect(await store.loadState()).toEqual({ round: 3 });
  });
});

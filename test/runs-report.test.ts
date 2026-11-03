import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRuns, readRun } from "../src/runs/report.js";

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

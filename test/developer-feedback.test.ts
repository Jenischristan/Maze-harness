import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliPolicyDeveloper } from "../src/developer/cli.js";
import type { DiscoveryTree, ReplayReport } from "../src/types.js";

let tmp = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dh-devfb-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function recordingCommand(): Promise<{
  command: string[];
  promptPath: string;
  policyPath: string;
}> {
  const dir = join(tmp, "cli");
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  const script = join(dir, "develop.mjs");
  const promptPath = join(dir, "prompt.txt");
  const policyPath = join(tmp, "rev-1", "policy.ts");

  const source = [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "let input = '';",
    "process.stdin.on('data', (c) => { input += c; });",
    "process.stdin.on('end', () => {",
    `  writeFileSync(${JSON.stringify(promptPath)}, input);`,
    `  writeFileSync(${JSON.stringify(policyPath)}, 'export default class P { async solve() {} }\\n');`,
    "});"
  ].join("\n");
  await writeFile(script, source, "utf8");
  return { command: [process.execPath, script], promptPath, policyPath };
}

function report(over: Partial<ReplayReport> = {}): ReplayReport {
  return {
    treeIndex: 0,
    policyId: "p",
    score: 0.25,
    best: 0.25,
    n: 2,
    k: 1,
    maxParallelism: 3,
    batches: [["root", "root"]],
    revealed: [],
    error: null,
    illegal: false,
    timedOut: false,
    wallMs: 5,
    ...over
  };
}

function tree(over: Partial<DiscoveryTree> = {}): DiscoveryTree {
  return {
    runId: "r",
    treeIndex: 0,
    baselineScore: 12.5,
    maxParallelism: 3,
    roundsLimit: 4,
    policyId: "seed",
    nodes: [],
    createdAt: new Date(0).toISOString(),
    ...over
  };
}

describe("developer feedback uses real worlds and objective", () => {
  it("renders the true tree baseline, not the normalized report best", async () => {
    const { command, promptPath } = await recordingCommand();
    const dev = new CliPolicyDeveloper({ command, workDir: tmp });
    await dev.revise({
      currentPolicySource: "export default class P { async solve() {} }",
      replayReports: [report({ best: 0.25 })],
      previousFeedback: [],
      trees: [tree({ baselineScore: 12.5 })],
      scoreConfig: { beta1: 0.5, beta2: 0.7, normalize: "relativeToBaseline", lambda: 2 }
    });
    const prompt = await readFile(promptPath, "utf8");

    const match = /Replay feedback: (.+)/.exec(prompt);
    expect(match).not.toBeNull();
    const notes = await readFile(match![1]!.trim(), "utf8");

    expect(notes).toContain("beta1=0.5");
    expect(notes).toContain("beta2=0.7");

    expect(notes).toContain("beta1=0.5 beta2=0.7 normalize=relativeToBaseline");
  });

  it("falls back to a neutral baseline when the caller passes no trees", async () => {
    const { command, promptPath } = await recordingCommand();
    const dev = new CliPolicyDeveloper({ command, workDir: tmp });
    await dev.revise({
      currentPolicySource: "export default class P { async solve() {} }",
      replayReports: [report()],
      previousFeedback: []
    });
    const prompt = await readFile(promptPath, "utf8");
    const notes = await readFile(/Replay feedback: (.+)/.exec(prompt)![1]!.trim(), "utf8");

    expect(notes).toContain("beta1=0.002");
    expect(notes).toContain("beta2=0.01");
  });
});

describe("offline phase passes real context to the developer", () => {
  it("hands revise() the evaluation trees and score config", async () => {
    const { runOfflinePhase } = await import("../src/loop/offline.js");
    const { RunStore } = await import("../src/runs/store.js");
    const { loadVariantSource } = await import("../src/policies/seed.js");
    const seed = await loadVariantSource("fixed", "seed");
    const seen: Array<{ trees?: DiscoveryTree[]; scoreConfig?: unknown }> = [];
    const evalTree = tree({ treeIndex: 0, baselineScore: 3.25 });
    const store = new RunStore({ rootDir: join(tmp, "runs"), runId: "devfb" });
    await store.init();
    const scoreConfig = { beta1: 0.1, beta2: 0.2, normalize: "none" as const };
    await runOfflinePhase({
      round: 1,
      currentPolicyId: "seed",
      currentPolicySource: seed.source,
      trees: [evalTree],
      histories: new Map(),
      developer: {
        async revise(input) {
          seen.push({ trees: input.trees, scoreConfig: input.scoreConfig });
          return seed.source;
        }
      },
      store,
      revisions: 1,
      scoreConfig,
      sandbox: { timeoutMs: 20000, memoryMb: 256 },
      policyWorkDir: join(tmp, "work"),
      betaGrid: null
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.trees).toHaveLength(1);
    expect(seen[0]!.trees![0]!.baselineScore).toBe(3.25);
    expect(seen[0]!.scoreConfig).toEqual(scoreConfig);
    expect(existsSync(join(tmp, "runs"))).toBe(true);
  }, 120_000);
});

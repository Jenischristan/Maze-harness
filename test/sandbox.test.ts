import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePolicy } from "../src/policies/loader.js";
import { runPolicyInSandbox } from "../src/policies/sandbox.js";
import { DEFAULT_SCORE_CONFIG } from "../src/score.js";
import { syntheticTree } from "./synthetic.js";

const tree = syntheticTree({
  seed: 3,
  branches: 2,
  refinements: 2,
  maxParallelism: 2,
  roundsLimit: 5
});

const goodPolicy = `
import { ROOT_ID } from "x";
export default class Good {
  async solve(env) {
    await env.probeBatch([env.legalActions()[0]]);
    const leaves = env.legalActions().slice(1);
    if (leaves.length) await env.probeBatch(leaves.slice(0, 1));
  }
}
`;

const crashPolicy = `
export default class Crash {
  async solve() {
    throw new Error("boom");
  }
}
`;

const hangPolicy = `
export default class Hang {
  async solve() {
    await new Promise(() => {});
  }
}
`;

const illegalPolicy = `
export default class Illegal {
  async solve(env) {
    await env.probeBatch(["nope"]);
  }
}
`;

async function sandbox(source: string, timeoutMs = 4000) {
  const dir = await mkdtemp(join(tmpdir(), "dh-sb-"));
  const id = `p${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const compiled = await compilePolicy({ source, outDir: dir, policyId: id });
  expect(compiled.ok).toBe(true);
  return runPolicyInSandbox({
    bundlePath: compiled.bundlePath as string,
    tree,
    priorHistory: [],
    policyId: id,
    config: { timeoutMs, memoryMb: 256, scoreConfig: DEFAULT_SCORE_CONFIG }
  });
}

describe("policy sandbox", () => {
  it("replays a valid policy and returns a finite score", async () => {
    const res = await sandbox(goodPolicy);
    expect(res.failed).toBe(false);
    expect(Number.isFinite(res.report.score)).toBe(true);
    expect(res.report.batches.length).toBeGreaterThan(0);
  });

  it("contains a crashing policy as -Infinity", async () => {
    const res = await sandbox(crashPolicy);
    expect(res.failed).toBe(true);
    expect(res.report.score).toBe(Number.NEGATIVE_INFINITY);
    expect(res.report.error).toContain("boom");
  });

  it("contains a hanging policy via timeout", async () => {
    const res = await sandbox(hangPolicy, 1500);
    expect(res.failed).toBe(true);
    expect(res.reason).toBe("timeout");
    expect(res.report.score).toBe(Number.NEGATIVE_INFINITY);
  }, 20000);

  it("contains an illegal batch policy", async () => {
    const res = await sandbox(illegalPolicy);
    expect(res.failed).toBe(true);
    expect(res.report.illegal).toBe(true);
    expect(res.report.score).toBe(Number.NEGATIVE_INFINITY);
  });

  it("fails compilation for broken source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dh-sb-"));
    const compiled = await compilePolicy({
      source: "export default class {",
      outDir: dir,
      policyId: "broken"
    });
    expect(compiled.ok).toBe(false);
    expect(compiled.error).toBeTruthy();
  });
});

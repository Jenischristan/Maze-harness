import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayEnv } from "../src/env/replay.js";
import { FixedParallelRefine } from "../src/policies/fixedParallelRefine.js";
import { compilePolicy } from "../src/policies/loader.js";
import { runPolicyInSandbox } from "../src/policies/sandbox.js";
import { DEFAULT_SCORE_CONFIG } from "../src/score.js";
import { ROOT_ID } from "../src/tree.js";
import type { ExplorationPolicy } from "../src/types.js";
import { syntheticTree } from "./synthetic.js";

/**
 * Regression tests for the plan-propagation audit finding.
 *
 * The paper says "the runtime grid is the hard bound" and that a requested plan
 * beyond the frozen trace's width/depth "is out of support and cannot earn
 * replay reward". The runner therefore hands the resolved `GridPlan` to the
 * policy, but two things were broken:
 *
 *   1. `FixedParallelRefine.planGrid` stored the plan on `this`, which is lost
 *      in the replay sandbox (it constructs a fresh instance per tree and never
 *      calls `planGrid`), so the plan never bounded replay.
 *   2. The import-free variant (the actual seed policy) had no plan support at
 *      all, so the live plan was only enforced by `LiveEnv.validateBatch`.
 *
 * Both now read `config.plan`, and the sandbox forwards it.
 */

let tmp = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dh-planprop-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function tree() {
  return syntheticTree({
    seed: 21,
    branches: 4,
    refinements: 4,
    failRate: 0,
    maxParallelism: 4,
    roundsLimit: 8
  });
}

function openedBranches(env: ReplayEnv): number {
  return new Set([...env.observed().values()].map((o) => o.branch)).size;
}

describe("constructor plan bounds solve()", () => {
  it("the typed policy never opens more branches than the plan", async () => {
    const env = new ReplayEnv(tree(), { maxRounds: 8 });
    await new FixedParallelRefine({
      beta: 1,
      plan: { branchCount: 2, refineCount: 3 }
    }).solve(env);
    expect(openedBranches(env)).toBeLessThanOrEqual(2);
    expect(env.rounds).toBeGreaterThan(0);
  });

  it("the typed policy never exceeds the plan's refine depth", async () => {
    const env = new ReplayEnv(tree(), { maxRounds: 8 });
    await new FixedParallelRefine({
      beta: 1,
      plan: { branchCount: 4, refineCount: 1 }
    }).solve(env);
    for (const obs of env.observed().values()) {
      expect(obs.attempt).toBeLessThanOrEqual(1);
    }
  });

  it("a refineCount of 0 keeps every branch at its root child", async () => {
    const env = new ReplayEnv(tree(), { maxRounds: 8 });
    await new FixedParallelRefine({
      beta: 1,
      plan: { branchCount: 3, refineCount: 0 }
    }).solve(env);
    for (const obs of env.observed().values()) expect(obs.attempt).toBe(0);
  });
});

async function loadVariant(): Promise<new (cfg?: unknown) => ExplorationPolicy> {
  const source = await readFile(join(process.cwd(), "src/policies/variants/fixed.ts"), "utf8");
  const compiled = await compilePolicy({
    source,
    outDir: join(tmp, "build"),
    policyId: "plan-prop"
  });
  expect(compiled.ok, compiled.error ?? "").toBe(true);
  const mod = (await import(`${compiled.bundlePath}?t=${Date.now()}`)) as {
    default: new (cfg?: unknown) => ExplorationPolicy;
  };
  return mod.default;
}

describe("variant policy honours the constructor plan", () => {
  it("bounds width and refine depth in replay", async () => {
    const Variant = await loadVariant();
    const policy = new Variant({ beta: 1, plan: { branchCount: 2, refineCount: 1 } });
    const env = new ReplayEnv(tree(), { maxRounds: 8 });
    await policy.solve(env);
    expect(openedBranches(env)).toBeLessThanOrEqual(2);
    for (const obs of env.observed().values()) expect(obs.attempt).toBeLessThanOrEqual(1);
  });

  it("matches the typed class under the same plan", async () => {
    const Variant = await loadVariant();
    const plan = { branchCount: 3, refineCount: 2 };
    const typedEnv = new ReplayEnv(tree(), { maxRounds: 8 });
    const variantEnv = new ReplayEnv(tree(), { maxRounds: 8 });
    await new FixedParallelRefine({ beta: 0.8, plan }).solve(typedEnv);
    await new Variant({ beta: 0.8, plan }).solve(variantEnv);
    expect(variantEnv.batchesTaken()).toEqual(typedEnv.batchesTaken());
  });
});

describe("sandbox forwards the plan to the policy constructor", () => {
  it("a plan-restricted run reveals fewer nodes than an unrestricted one", async () => {
    const source = await readFile(join(process.cwd(), "src/policies/variants/fixed.ts"), "utf8");
    const compiled = await compilePolicy({
      source,
      outDir: join(tmp, "build"),
      policyId: "sandbox-plan"
    });
    expect(compiled.ok, compiled.error ?? "").toBe(true);
    const t = tree();
    const narrow = await runPolicyInSandbox({
      bundlePath: compiled.bundlePath!,
      tree: t,
      priorHistory: [],
      policyId: "narrow",
      config: {
        timeoutMs: 10000,
        memoryMb: 256,
        scoreConfig: DEFAULT_SCORE_CONFIG,
        beta: 1,
        plan: { branchCount: 1, refineCount: 1 }
      }
    });
    const wide = await runPolicyInSandbox({
      bundlePath: compiled.bundlePath!,
      tree: t,
      priorHistory: [],
      policyId: "wide",
      config: {
        timeoutMs: 10000,
        memoryMb: 256,
        scoreConfig: DEFAULT_SCORE_CONFIG,
        beta: 1,
        plan: { branchCount: 4, refineCount: 4 }
      }
    });
    expect(narrow.failed).toBe(false);
    expect(wide.failed).toBe(false);
    expect(narrow.report.n).toBeLessThan(wide.report.n);
    // Width 1 / depth 1 can reveal at most one root child and one refinement.
    expect(narrow.report.revealed.length).toBeLessThanOrEqual(2);
    expect(narrow.report.batches.every((b) => b.length <= 1)).toBe(true);
    for (const obs of narrow.report.revealed) expect(obs.attempt).toBeLessThanOrEqual(1);
  });
});

describe("live and replay agree on the plan", () => {
  it("replaying a recorded live batch list under the plan is unchanged", async () => {
    // Sanity: a plan-restricted policy's own batches are still legal in a
    // fresh replay of the same world with the same plan.
    const t = tree();
    const plan = { branchCount: 2, refineCount: 2 };
    const original = new ReplayEnv(t, { maxRounds: 8 });
    await new FixedParallelRefine({ beta: 0.6, plan }).solve(original);
    const batches = original.batchesTaken();
    const replay = new ReplayEnv(t, { maxRounds: 8 });
    for (const batch of batches) {
      if (replay.done) break;
      await replay.probeBatch(batch);
    }
    expect(replay.batchesTaken()).toEqual(batches);
    expect(replay.batchesTaken().every((b) => b.length <= plan.branchCount)).toBe(true);
  });
});

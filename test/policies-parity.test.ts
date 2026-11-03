import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedParallelRefine } from "../src/policies/fixedParallelRefine.js";
import { compilePolicy } from "../src/policies/loader.js";
import { ReplayEnv } from "../src/env/replay.js";
import { syntheticTree } from "./synthetic.js";
import type { ExplorationPolicy } from "../src/types.js";

/**
 * The fixed-parallel-refine policy exists twice on purpose: as a typed class the
 * harness runs, and as import-free source text the replay sandbox compiles.
 * These tests pin them to the same behaviour so a fix in one cannot silently
 * leave the other behind — which is exactly how they drifted before.
 */

let tmp = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dh-parity-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function tree(seed: number) {
  return syntheticTree({
    seed,
    branches: 3,
    refinements: 3,
    failRate: 0.1,
    dominantBranch: 1,
    dominantBoost: 0.7,
    maxParallelism: 3,
    roundsLimit: 6
  });
}

async function loadVariant(): Promise<ExplorationPolicy> {
  const source = await readFile(join(process.cwd(), "src/policies/variants/fixed.ts"), "utf8");
  const compiled = await compilePolicy({
    source,
    outDir: join(tmp, "build"),
    policyId: "fixed-parity"
  });
  expect(compiled.ok, compiled.error ?? "").toBe(true);
  const mod = (await import(`${compiled.bundlePath}?t=${Date.now()}`)) as {
    default: new (cfg?: unknown) => ExplorationPolicy;
  };
  return new mod.default();
}

describe("fixed policy: sandbox source matches the typed class", () => {
  it("picks identical batches and reveals identical nodes on the same tree", async () => {
    const policy = await loadVariant();
    for (const seed of [1, 2, 3, 7, 11]) {
      const typedEnv = new ReplayEnv(tree(seed), { maxRounds: 6 });
      const variantEnv = new ReplayEnv(tree(seed), { maxRounds: 6 });

      await new FixedParallelRefine().solve(typedEnv);
      await policy.solve(variantEnv);

      expect(variantEnv.batchesTaken()).toEqual(typedEnv.batchesTaken());
      expect([...variantEnv.observed().keys()].sort()).toEqual(
        [...typedEnv.observed().keys()].sort()
      );
    }
  });

  it("stops instead of spinning when the frontier is stale", async () => {
    // A tree whose only recorded node is the root: refining a leaf cannot
    // reveal anything, so the policy must give up rather than burn every round.
    const t = tree(5);
    const rootOnly = {
      ...t,
      nodes: t.nodes.filter((n) => n.id === "root")
    };
    const env = new ReplayEnv(rootOnly, { maxRounds: 6 });
    const policy = await loadVariant();
    await policy.solve(env);
    // With no legal leaf the variant opens root branches and stops; it must not
    // record a batch of non-root ids that reveals nothing.
    for (const batch of env.batchesTaken()) {
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.some((id) => id === "root")).toBe(true);
    }
  });
});

/**
 * Guard the other half of the drift: the checked-in scaffold must not spawn
 * example MCP servers, and the persisted project config must not pin an
 * absolute temp path.
 */
describe("checked-in .dream scaffold", () => {
  it("declares no live MCP servers", async () => {
    const raw = JSON.parse(await readFile(join(process.cwd(), ".dream/mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers ?? {}).toEqual({});
  });

  it("keeps runsDir relative", async () => {
    const raw = JSON.parse(await readFile(join(process.cwd(), ".dream/config.json"), "utf8")) as {
      runsDir?: string;
    };
    expect(raw.runsDir).toBe("runs");
  });
});

describe("CLI version", () => {
  it("matches package.json", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    const { versionFromCli } = await import("../src/cli-version.js");
    expect(await versionFromCli()).toBe(pkg.version);
  });
});

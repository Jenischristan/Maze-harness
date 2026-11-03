import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedParallelRefine } from "../src/policies/fixedParallelRefine.js";
import { compilePolicy } from "../src/policies/loader.js";
import { ReplayEnv } from "../src/env/replay.js";
import { syntheticTree } from "./synthetic.js";
import type { ExplorationPolicy } from "../src/types.js";

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
    const t = tree(5);
    const rootOnly = {
      ...t,
      nodes: t.nodes.filter((n) => n.id === "root")
    };
    const env = new ReplayEnv(rootOnly, { maxRounds: 6 });
    const policy = await loadVariant();
    await policy.solve(env);

    for (const batch of env.batchesTaken()) {
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.some((id) => id === "root")).toBe(true);
    }
  });
});

describe("checked-in .dream scaffold", () => {
  it("declares no live MCP servers", async () => {
    const raw = JSON.parse(await readFile(join(process.cwd(), ".dream/mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers ?? {}).toEqual({});
  });

  it("ships no persisted project config", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(process.cwd(), ".dream/config.json"))).toBe(false);
    const root = await mkdtemp(join(tmpdir(), "dh-init-cfg-"));
    try {
      const { initProject } = await import("../src/project-init.js");
      const result = await initProject(root);
      expect(result.created).not.toContain(".dream/config.json");
      expect(existsSync(join(root, ".dream/config.json"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

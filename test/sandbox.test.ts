import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePolicy } from "../src/policies/loader.js";
import {
  runPolicyInSandbox,
  SANDBOX_ENV_ALLOWLIST,
  SANDBOX_NODE_FLAGS,
  sandboxEnv
} from "../src/policies/sandbox.js";
import { DEFAULT_SCORE_CONFIG } from "../src/score.js";
import { seedPolicySource } from "../src/policies/seed.js";
import { syntheticTree } from "./synthetic.js";

const tree = syntheticTree({
  seed: 3,
  branches: 2,
  refinements: 2,
  maxParallelism: 2,
  roundsLimit: 5
});

function emptyTree(): typeof tree {
  return syntheticTree({ seed: 1, branches: 0, refinements: 0, maxParallelism: 2, roundsLimit: 2 });
}

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

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-merged-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

describe("policy sandbox hardening", () => {
  it("only forwards allowlisted env keys and never NODE_OPTIONS", () => {
    const env = sandboxEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      OPENAI_API_KEY: "sk-secret",
      DREAM_API_KEY: "sk-secret",
      NODE_OPTIONS: "--require ./evil.js --inspect",
      NODE_PATH: "/tmp/node_modules",
      LD_PRELOAD: "/tmp/evil.so",
      AWS_SECRET_ACCESS_KEY: "secret"
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });

    for (const key of Object.keys(env)) {
      expect(SANDBOX_ENV_ALLOWLIST as readonly string[]).toContain(key);
    }
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DREAM_API_KEY).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(
      Object.keys(env).every((k) => (SANDBOX_ENV_ALLOWLIST as readonly string[]).includes(k))
    ).toBe(true);
  });

  it("passes the hardened Node flags to the child", () => {
    expect(SANDBOX_NODE_FLAGS).toContain("--frozen-intrinsics");
    expect(SANDBOX_NODE_FLAGS).toContain("--disable-proto=throw");
    expect(SANDBOX_NODE_FLAGS).toContain("--no-addons");
  });

  it("a policy cannot read secrets from its environment", async () => {
    const probe = `
      export default class Probe {
        async solve(env) {
          const secret = process.env.DREAM_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
          if (secret !== null) throw new Error("secret leaked: " + secret);
          await env.probeBatch([]);
        }
      }
    `;
    process.env.DREAM_API_KEY = "sk-should-not-leak";
    try {
      const res = await sandbox(probe);
      expect(res.failed).toBe(false);
      expect(Number.isFinite(res.report.score)).toBe(true);
    } finally {
      delete process.env.DREAM_API_KEY;
    }
  });

  it("a policy that writes __proto__ is contained as -Infinity", async () => {
    const pollution = `
      export default class Pollution {
        async solve(env) {


          ({}).__proto__ = { polluted: true };
          await env.probeBatch([]);
        }
      }
    `;
    const res = await sandbox(pollution);
    expect(res.failed).toBe(true);
    expect(res.report.score).toBe(Number.NEGATIVE_INFINITY);
    expect(res.report.error).toBeTruthy();
  });
});

describe("policy sandbox: failure containment", () => {
  it("uses a whitelisted environment only", () => {
    const env = sandboxEnv({
      PATH: "/bin",
      HOME: "/h",
      DREAM_API_KEY: "secret",
      LANG: "C"
    } as never);
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/h");
    expect(env.LANG).toBe("C");
    expect(env.DREAM_API_KEY).toBeUndefined();
    for (const key of Object.keys(env)) {
      expect(SANDBOX_ENV_ALLOWLIST).toContain(key);
    }
  });

  it("scores a valid seeded policy", async () => {
    const seed = await seedPolicySource("fixed");
    const bundlePath = join(dir, "policy.ts");
    await writeFile(bundlePath, seed.source);
    const result = await runPolicyInSandbox({
      bundlePath,
      tree: emptyTree(),
      priorHistory: [],
      policyId: "fixed",
      config: {
        timeoutMs: 60_000,
        memoryMb: 256,
        scoreConfig: { beta1: 0.002, beta2: 0.01, normalize: "relativeToBaseline" }
      }
    });
    expect(typeof result.report.score).toBe("number");
    expect(result.report.treeIndex).toBe(emptyTree().treeIndex);
    expect(result.failed).toBe(false);
  }, 120_000);

  it("contains a module that does not default-export a class", async () => {
    const bundlePath = join(dir, "bad.ts");
    await writeFile(bundlePath, "export const nope = 1;\n");
    const result = await runPolicyInSandbox({
      bundlePath,
      tree: emptyTree(),
      priorHistory: [],
      policyId: "bad",
      config: {
        timeoutMs: 60_000,
        memoryMb: 256,
        scoreConfig: { beta1: 0, beta2: 0, normalize: "none" }
      }
    });
    expect(result.failed).toBe(true);
    expect(result.report.error).toContain("default-export");
  }, 120_000);

  it("contains a policy whose solve throws", async () => {
    const bundlePath = join(dir, "throw.ts");
    await writeFile(
      bundlePath,
      "export default class P { async solve() { throw new Error('kaboom'); } }\n"
    );
    const result = await runPolicyInSandbox({
      bundlePath,
      tree: emptyTree(),
      priorHistory: [],
      policyId: "throw",
      config: {
        timeoutMs: 60_000,
        memoryMb: 256,
        scoreConfig: { beta1: 0, beta2: 0, normalize: "none" }
      }
    });
    expect(result.failed).toBe(true);
    expect(result.report.error).toBe("kaboom");
    expect(result.report.illegal).toBe(false);
  }, 120_000);

  it("marks a policy that violates the batch rules as illegal", async () => {
    const bundlePath = join(dir, "illegal.ts");
    await writeFile(
      bundlePath,
      [
        "export default class P {",
        "  async solve(env) {",
        "    await env.probeBatch(['not-a-legal-cell']);",
        "  }",
        "}",
        ""
      ].join("\n")
    );
    const result = await runPolicyInSandbox({
      bundlePath,
      tree: emptyTree(),
      priorHistory: [],
      policyId: "illegal",
      config: {
        timeoutMs: 60_000,
        memoryMb: 256,
        scoreConfig: { beta1: 0, beta2: 0, normalize: "none" }
      }
    });
    expect(result.failed).toBe(true);
    expect(result.reason).toBe("illegal");
  }, 120_000);
});

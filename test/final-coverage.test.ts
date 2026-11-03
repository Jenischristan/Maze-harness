import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "../src/tools/read.js";
import { Hooks } from "../src/tools/hooks.js";
import { runPolicyInSandbox, sandboxEnv, SANDBOX_ENV_ALLOWLIST } from "../src/policies/sandbox.js";
import { seedPolicySource } from "../src/policies/seed.js";
import type { DiscoveryTree, ToolContext } from "../src/types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-final-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: dir,
    readFiles: new Set(),
    readHashes: new Map(),
    modifiedFiles: new Set(),
    maxOutputBytes: 32 * 1024,
    permission: { defaultAction: "allow", rules: [] },
    hooks: { register: () => undefined, list: () => [], runAll: async () => [] },
    ...overrides
  };
}

function tree(): DiscoveryTree {
  return {
    runId: "r",
    treeIndex: 0,
    baselineScore: 1,
    maxParallelism: 2,
    roundsLimit: 2,
    policyId: "p",
    createdAt: "t",
    nodes: []
  };
}

describe("read: PDF extraction paths", () => {
  it("reports pdf-no-extractor when pdftotext is unavailable", async () => {
    await writeFile(join(dir, "doc.pdf"), Buffer.from("%PDF-1.4 fake"));
    const res = await readTool.execute({ path: "doc.pdf" }, ctx());
    if (res.ok) {
      expect(res.data).toMatchObject({ mediaType: "application/pdf" });
    } else {
      expect(res.error).toBe("pdf-no-extractor");
      expect(res.content).toContain("pdftotext");
    }
  });

  it("never throws for a corrupt PDF", async () => {
    await writeFile(join(dir, "bad.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]));
    const res = await readTool.execute({ path: "bad.pdf" }, ctx());
    expect(typeof res.content).toBe("string");
  });
});

describe("hooks: abort and spawn failure", () => {
  it("kills a hook when the signal aborts mid-run", async () => {
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 20_000, maxOutputBytes: 4096 });
    hooks.register({ name: "slow", command: "sleep 30" });
    const ac = new AbortController();
    const p = hooks.runAll(ac.signal);
    setTimeout(() => ac.abort(), 100);
    const results = await p;
    expect(results[0]!.ok).toBe(false);
  }, 20_000);

  it("reports a spawn failure as a failed hook with output", async () => {
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 });
    hooks.register({ name: "missing", command: "/definitely/not/a/binary-xyz 2>/dev/null" });
    const [r] = await hooks.runAll();
    expect(r!.ok).toBe(false);
    expect(r!.wallMs).toBeGreaterThanOrEqual(0);
  });

  it("runs hooks with a custom env map", async () => {
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 });
    hooks.register({ name: "env", command: 'test "$HOOK_VAR" = yes', env: { HOOK_VAR: "yes" } });
    const [r] = await hooks.runAll();
    expect(r!.ok).toBe(true);
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
      tree: tree(),
      priorHistory: [],
      policyId: "fixed",
      config: {
        timeoutMs: 60_000,
        memoryMb: 256,
        scoreConfig: { beta1: 0.002, beta2: 0.01, normalize: "relativeToBaseline" }
      }
    });
    expect(typeof result.report.score).toBe("number");
    expect(result.report.treeIndex).toBe(0);
  }, 120_000);

  it("contains a module that does not default-export a class", async () => {
    const bundlePath = join(dir, "bad.ts");
    await writeFile(bundlePath, "export const nope = 1;\n");
    const result = await runPolicyInSandbox({
      bundlePath,
      tree: tree(),
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
      tree: tree(),
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
      tree: tree(),
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

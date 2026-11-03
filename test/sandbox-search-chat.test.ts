import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globToRegExp, grepTool, globTool } from "../src/tools/search.js";
import { runPolicyInSandbox } from "../src/policies/sandbox.js";
import { buildSession, sessionsDir } from "../src/chat.js";
import type { DiscoveryTree } from "../src/types.js";
import { emptyTree, makeTempDir, toolContext } from "./helpers/fixtures.js";
import { loadVariantSource, seedPolicySource } from "../src/policies/seed.js";

let dir = "";
let cleanup = async (): Promise<void> => undefined;

beforeEach(async () => {
  const t = await makeTempDir("dh-ssc");
  dir = t.dir;
  cleanup = t.remove;
});

afterEach(async () => {
  delete process.env.MAZE_SESSIONS_DIR;
  await cleanup();
});

const ctx = (overrides: Record<string, unknown> = {}) => toolContext(dir, overrides as never);

function tree(): DiscoveryTree {
  return emptyTree({ roundsLimit: 2 });
}

describe("search: engine fallbacks and error paths", () => {
  it("glob falls back to a bare-filename match", async () => {
    await mkdir(join(dir, "deep", "er"), { recursive: true });
    await writeFile(join(dir, "deep", "er", "x.ts"), "x");
    expect((await globTool.execute({ pattern: "x.ts" }, ctx())).content).toContain("deep/er/x.ts");
  });

  it("glob skips dependency and cache directories", async () => {
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "a.ts"), "x");
    await mkdir(join(dir, "coverage"), { recursive: true });
    await writeFile(join(dir, "coverage", "c.ts"), "x");
    await writeFile(join(dir, "real.ts"), "x");
    const res = await globTool.execute({ pattern: "**/*.ts" }, ctx());
    expect(res.content).toContain("real.ts");
    expect(res.content).not.toContain("node_modules");
    expect(res.content).not.toContain("coverage");
  });

  it("grep reports a truncation token for a large result set", async () => {
    await writeFile(join(dir, "big.txt"), `${"needle\n".repeat(2000)}`);
    const res = await grepTool.execute({ pattern: "needle" }, ctx({ maxOutputBytes: 200 }));
    expect(res.truncated?.pageToken).toBeDefined();
  });

  it("grep handles a directory it cannot read", async () => {
    const res = await grepTool.execute({ pattern: "x", path: "missing-dir" }, ctx());
    // Either an error or an empty result, but never a throw.
    expect(typeof res.content).toBe("string");
  });

  it("globToRegExp handles a literal brace and bracket", () => {
    expect(globToRegExp("a{b}").test("a{b}")).toBe(true);
    expect(globToRegExp("[x]").test("[x]")).toBe(true);
    expect(globToRegExp("a**").test("abc")).toBe(true);
  });
});

describe("policy sandbox: runner resolution and failures", () => {
  it("contains a policy that does not call solve", async () => {
    const bundlePath = join(dir, "nosolve.ts");
    await writeFile(bundlePath, "export default class P {}\n");
    const result = await runPolicyInSandbox({
      bundlePath,
      tree: tree(),
      priorHistory: [],
      policyId: "nosolve",
      config: {
        timeoutMs: 60_000,
        memoryMb: 256,
        scoreConfig: { beta1: 0, beta2: 0, normalize: "none" }
      }
    });
    expect(result.failed).toBe(true);
    expect(result.report.error).toContain("solve");
  }, 120_000);

  it("contains a policy module that fails to import", async () => {
    const bundlePath = join(dir, "syntax.ts");
    await writeFile(bundlePath, "export default class P { this is not ts }");
    const result = await runPolicyInSandbox({
      bundlePath,
      tree: tree(),
      priorHistory: [],
      policyId: "syntax",
      config: {
        timeoutMs: 60_000,
        memoryMb: 256,
        scoreConfig: { beta1: 0, beta2: 0, normalize: "none" }
      }
    });
    expect(result.failed).toBe(true);
    expect(result.report.error).toBeTruthy();
  }, 120_000);

  it("reports a timeout as a failed report with timedOut set", async () => {
    const bundlePath = join(dir, "hang.ts");
    await writeFile(
      bundlePath,
      "export default class P { async solve() { await new Promise(() => {}); } }\n"
    );
    const result = await runPolicyInSandbox({
      bundlePath,
      tree: tree(),
      priorHistory: [],
      policyId: "hang",
      config: {
        timeoutMs: 400,
        memoryMb: 256,
        scoreConfig: { beta1: 0, beta2: 0, normalize: "none" }
      }
    });
    expect(result.reason).toBe("timeout");
    expect(result.report.timedOut).toBe(true);
    expect(result.report.score).toBe(Number.NEGATIVE_INFINITY);
  }, 120_000);

  it("passes beta and plan into the policy constructor", async () => {
    const bundlePath = join(dir, "cfg.ts");
    await writeFile(
      bundlePath,
      [
        "export default class P {",
        "  constructor(cfg) { this.cfg = cfg; }",
        "  async solve(env) { if (this.cfg.beta !== 0.25) throw new Error('beta missing'); }",
        "}",
        ""
      ].join("\n")
    );
    const result = await runPolicyInSandbox({
      bundlePath,
      tree: tree(),
      priorHistory: [],
      policyId: "cfg",
      config: {
        timeoutMs: 60_000,
        memoryMb: 256,
        scoreConfig: { beta1: 0, beta2: 0, normalize: "none" },
        beta: 0.25,
        plan: { branchCount: 1, refineCount: 0 }
      }
    });
    expect(result.report.error).toBeNull();
  }, 120_000);
});

describe("chat: session wiring", () => {
  it("builds a session in a custom sessions directory", async () => {
    const sessions = join(dir, "custom-sessions");
    const built = await buildSession({
      model: "deepseek-chat",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k",
      runsDir: sessions,
      verifyCommands: [],
      permission: "deny"
    });
    expect(built.session.path.startsWith(sessions)).toBe(true);
    expect(built.session.meta.cwd).toBe(process.cwd());
    const raw = await readFile(built.session.path, "utf8");
    expect(raw).toContain('"kind":"header"');
    built.toolset.close();
  });

  it("honours MAZE_SESSIONS_DIR", () => {
    process.env.MAZE_SESSIONS_DIR = join(dir, "env-sessions");
    expect(sessionsDir()).toBe(join(dir, "env-sessions"));
  });
});

describe("policies/seed", () => {
  it("loads the fixed variant source", async () => {
    const src = await loadVariantSource("fixed");
    expect(src.policyId).toBe("fixed");
    expect(src.source).toContain("class");
  });

  it("loads the greedy variant with a custom policy id", async () => {
    const src = await loadVariantSource("greedy", "greedy-7");
    expect(src.policyId).toBe("greedy-7");
    expect(src.source.length).toBeGreaterThan(0);
  });

  it("seeds greedy when the policy id starts with greedy, else fixed", async () => {
    expect((await seedPolicySource("greedy-1")).source).toBe(
      (await loadVariantSource("greedy")).source
    );
    expect((await seedPolicySource("other")).source).toBe(
      (await loadVariantSource("fixed")).source
    );
    expect((await seedPolicySource()).policyId).toBe("fixed");
  });
});

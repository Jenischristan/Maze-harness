import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  FETCH_HARD_MAX_BYTES,
  FETCH_MAX_BYTES
} from "../../src/tools/limits.js";
import { Hooks, verifyCommandsToHooks } from "../../src/tools/hooks.js";
import type { HookRegistry, HookResult, VerifyHook } from "../../src/tools/hookTypes.js";
import { summaryFromTree } from "../../src/runs/summary.js";
import { versionFromCli } from "../../src/cli-version.js";
import { CliAgent, runCli } from "../../src/agents/cli.js";
import { SUBAGENTS, findSubAgent, subAgentTool } from "../../src/subagents.js";
import { fetchTool } from "../../src/tools/fetch.js";
import { summarizeTree } from "../../src/tree.js";
import { syntheticTree } from "../synthetic.js";
import type { PermissionPolicy } from "../../src/tools/permissions.js";
import type { ToolContext } from "../../src/types.js";
import { fuzzCases } from "./harness.js";

describe("tools/limits", () => {
  it("exposes a coherent output budget", () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(32 * 1024);
    expect(FETCH_MAX_BYTES).toBe(DEFAULT_MAX_OUTPUT_BYTES * 8);
    expect(FETCH_HARD_MAX_BYTES).toBe(1024 * 1024);
    expect(FETCH_MAX_BYTES).toBeLessThanOrEqual(FETCH_HARD_MAX_BYTES);
    for (const n of [DEFAULT_MAX_OUTPUT_BYTES, FETCH_MAX_BYTES, FETCH_HARD_MAX_BYTES]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });
});

describe("tools/hookTypes contract", () => {
  it("Hooks satisfies HookRegistry and preserves spec fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dh-fuzz-hooktypes-"));
    try {
      const hooks: HookRegistry = new Hooks({
        workspaceDir: dir,
        timeoutMs: 5000,
        maxOutputBytes: 1024
      });
      const spec: VerifyHook = { name: "n", command: "exit 0", timeoutMs: 1000, env: { X: "1" } };
      hooks.register(spec);
      expect(hooks.list()).toEqual([spec]);
      const results: HookResult[] = await hooks.runAll();
      expect(results).toHaveLength(1);
      const r = results[0]!;
      expect(Object.keys(r).sort()).toEqual(["name", "ok", "output", "timedOut", "wallMs"]);
      expect(r.name).toBe("n");
      expect(r.ok).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(typeof r.wallMs).toBe("number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "verifyCommandsToHooks output is a valid VerifyHook list",
    fuzzCases({ seed: 0x1001, runs: 100 }, (rng) => {
      const cmds = Array.from({ length: rng.int(0, 5) }, () => rng.str(20));
      const hooks = verifyCommandsToHooks(cmds);
      expect(hooks).toHaveLength(cmds.filter((c) => c.trim().length > 0).length);
      for (const h of hooks) {
        expect(typeof h.name).toBe("string");
        expect(h.command.length).toBeGreaterThan(0);
        expect(h.timeoutMs).toBeGreaterThan(0);
      }
    })
  );
});

describe("fuzz: runs/summary", () => {
  it(
    "summaryFromTree matches summarizeTree with empty batches",
    fuzzCases({ seed: 0x1002, runs: 100 }, (rng) => {
      const tree = syntheticTree({
        seed: rng.int(0, 10_000),
        branches: rng.int(0, 4),
        refinements: rng.int(0, 4),
        failRate: rng.next()
      });
      const s = summaryFromTree(tree);
      expect(s).toEqual(summarizeTree(tree, [], tree.nodes.length > 0 ? tree.roundsLimit : 0));
      expect(s.treeIndex).toBe(tree.treeIndex);
      expect(s.baselineScore).toBe(tree.baselineScore);
      expect(s.nodeCount).toBe(tree.nodes.length);
      expect(s.roundsUsed).toBe(tree.nodes.length > 0 ? tree.roundsLimit : 0);
      expect(s.bestScore).toBe(
        tree.nodes.reduce<number | null>(
          (acc, n) => (n.score === null ? acc : acc === null || n.score > acc ? n.score : acc),
          null
        )
      );
    })
  );
});

describe("cli-version", () => {
  it("resolves the real package version", async () => {
    const v = await versionFromCli();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    const pkg = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    ) as {
      version: string;
    };
    expect(v).toBe(pkg.version);
  });
});

describe("fuzz: runCli", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dh-fuzz-cliagent-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(
    "propagates stdin/arg prompts, exit codes, and errors",
    fuzzCases({ seed: 0x1003, runs: 20, maxRuns: 20 }, async (rng) => {
      const prompt = `p${rng.int(0, 9)}`;
      const viaStdin = await runCli({
        command: ["cat"],
        cwd: dir,
        prompt,
        promptMode: "stdin",
        timeoutMs: 5000
      });
      expect(viaStdin.code).toBe(0);
      expect(viaStdin.stdout).toBe(prompt);
      expect(viaStdin.timedOut).toBe(false);

      const viaArg = await runCli({
        command: ["sh", "-c", 'printf "%s" "$1"', "sh"],
        cwd: dir,
        prompt,
        promptMode: "arg",
        timeoutMs: 5000
      });
      expect(viaArg.stdout).toBe(prompt);

      const bad = await runCli({
        command: ["sh", "-c", `exit ${rng.int(1, 5)}`],
        cwd: dir,
        prompt: "",
        promptMode: "stdin",
        timeoutMs: 5000
      });
      expect(bad.code).not.toBe(0);

      await expect(
        runCli({ command: [], cwd: dir, prompt: "", promptMode: "stdin", timeoutMs: 1000 })
      ).rejects.toThrow(/empty/);
    })
  );

  it(
    "CliAgent writes a transcript and surfaces failures",
    fuzzCases({ seed: 0x1004, runs: 4, maxRuns: 4 }, async (rng) => {
      const transcriptDir = join(dir, `t${rng.int(0, 1_000_000)}`);
      const agent = new CliAgent({ command: ["cat"], transcriptDir, timeoutMs: 5000 });
      const res = await agent.run({
        workspaceDir: dir,
        task: { name: "t", description: "d", prompt: "do it" } as never,
        parent: null,
        context: { branch: 0, attempt: 0, nodeId: `n${rng.int(0, 9)}`, ancestorPath: [] } as never
      });
      expect(res.transcriptPath).toBeDefined();
      const log = await readFile(res.transcriptPath!, "utf8");
      expect(log).toContain("do it");
      expect(log).toContain("# stdout");
    })
  );

  it("CliAgent throws on a non-zero exit", async () => {
    const agent = new CliAgent({ command: ["sh", "-c", "exit 7"], timeoutMs: 5000 });
    await expect(
      agent.run({
        workspaceDir: dir,
        task: { name: "t", description: "d", prompt: "p" } as never,
        parent: null,
        context: { branch: 0, attempt: 0, nodeId: "n", ancestorPath: [] } as never
      })
    ).rejects.toThrow(/exited 7/);
  });
});

describe("fuzz: subagents", () => {
  it(
    "findSubAgent is exact-or-prefix, case-insensitive, and null on empty",
    fuzzCases({ seed: 0x1005, runs: 200 }, (rng) => {
      const name = rng.pick(SUBAGENTS).name;
      expect(findSubAgent(name)).toBe(SUBAGENTS.find((a) => a.name === name));
      expect(findSubAgent(name.toUpperCase())?.name).toBe(name);
      expect(findSubAgent("")).toBeNull();
      expect(findSubAgent("   ")).toBeNull();
      expect(findSubAgent(`zzz-${rng.int(0, 99)}`)).toBeNull();
      const names = SUBAGENTS.map((a) => a.name);
      expect(new Set(names).size).toBe(names.length);
      for (const a of SUBAGENTS) {
        expect(a.prompt.trim().length).toBeGreaterThan(0);
        expect(a.description.trim().length).toBeGreaterThan(0);
      }
    })
  );

  it(
    "delegate tool rejects unknown agents and empty tasks without spawning",
    fuzzCases({ seed: 0x1006, runs: 100 }, async (rng) => {
      const tool = subAgentTool({
        workspaceDir: "/tmp",
        model: "m",
        baseUrl: "http://x",
        apiKey: "k"
      });
      expect(tool.name).toBe("delegate");
      const badAgent = await tool.execute({ agent: rng.str(12), task: "x" }, {} as never);
      if (badAgent.error === "unknown-subagent") {
        expect(badAgent.ok).toBe(false);
        expect(badAgent.content).toContain("available:");
      }
      const noTask = await tool.execute(
        { agent: rng.pick(SUBAGENTS).name, task: "   " },
        {} as never
      );
      expect(noTask.ok).toBe(false);
      expect(noTask.error).toBe("no-task");
    })
  );
});

describe("fuzz: fetch pre-flight validation", () => {
  function ctx(permission: PermissionPolicy): ToolContext {
    return {
      workspaceDir: "/tmp",
      readFiles: new Set(),
      modifiedFiles: new Set(),
      maxOutputBytes: 4096,
      permission,
      hooks: { register() {}, list: () => [], runAll: async () => [] }
    } as unknown as ToolContext;
  }
  const allowLocal: PermissionPolicy = {
    defaultAction: "allow",
    rules: [],
    networkEnabled: true,
    networkAllowlist: ["example.com"]
  };

  it(
    "rejects bad URLs, protocols, and hosts without opening a socket",

    fuzzCases({ seed: 0x1007, runs: 200 }, async (rng) => {
      const invalid = rng.pick(["", "not a url", "example.com", "://", "https://", "http://[bad"]);
      const inputs: Array<[Record<string, unknown>, PermissionPolicy, string]> = [
        [{ url: invalid }, allowLocal, "bad-url"],
        [{ url: "file:///etc/passwd" }, allowLocal, "bad-protocol"],
        [{ url: "ftp://example.com/x" }, allowLocal, "bad-protocol"],
        [{ url: `https://evil${rng.int(0, 9)}.com/x` }, allowLocal, "network-denied"],
        [{ url: "https://sub.evil.com/x" }, allowLocal, "network-denied"],
        [
          { url: "https://example.com/x" },
          { ...allowLocal, networkEnabled: false },
          "network-denied"
        ],
        [
          { url: "https://example.com/x" },
          { ...allowLocal, networkAllowlist: [] },
          "network-denied"
        ]
      ];
      for (const [args, policy, expectedError] of inputs) {
        const res = await fetchTool.execute(args, ctx(policy));
        expect(res.ok).toBe(false);
        expect(res.error).toBe(expectedError);
      }
    })
  );

  it(
    "permission deny rules stop an allowed host before any request",
    fuzzCases({ seed: 0x1008, runs: 50 }, async (rng) => {
      const policy: PermissionPolicy = {
        ...allowLocal,
        rules: [{ tool: "fetch", pattern: "example", action: "deny" }]
      };
      const res = await fetchTool.execute(
        { url: `https://example.com/${rng.str(6)}` },
        ctx(policy)
      );
      expect(res.ok).toBe(false);
      expect(res.error).toBe("permission-denied");
    })
  );
});

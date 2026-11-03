import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionsDir, buildSession } from "../src/chat.js";
import { CliPolicyDeveloper } from "../src/developer/cli.js";
import { renderFeedbackMarkdown, buildFeedbackReport } from "../src/developer/report.js";
import { formatHookFeedback } from "../src/agent/verify.js";
import type { DiscoveryTree, ReplayReport } from "../src/types.js";
import { makeTempDir } from "./helpers/fixtures.js";

let dir = "";
let cleanup = async (): Promise<void> => undefined;

beforeEach(async () => {
  const t = await makeTempDir("dh-chatdev");
  dir = t.dir;
  cleanup = t.remove;
});

afterEach(async () => {
  delete process.env.MAZE_SESSIONS_DIR;
  delete process.env.XDG_DATA_HOME;
  await cleanup();
});

function tree(index = 0): DiscoveryTree {
  return {
    runId: "r",
    treeIndex: index,
    baselineScore: 1,
    maxParallelism: 2,
    roundsLimit: 3,
    policyId: "p",
    createdAt: "t",
    nodes: []
  };
}

function report(overrides: Partial<ReplayReport> = {}): ReplayReport {
  return {
    treeIndex: 0,
    policyId: "p",
    score: 0.5,
    best: 0.4,
    n: 2,
    k: 1,
    maxParallelism: 2,
    batches: [["a", "b"]],
    revealed: [
      {
        id: "a",
        branch: 0,
        attempt: 0,
        parentId: "",
        seq: 0,
        score: 1.2,
        valid: true,
        failClass: "ok",
        error: null,
        deltaVsBaseline: 0.2,
        deltaVsParent: null,
        nValid: null,
        nTotal: null,
        tags: [],
        branchPromising: true,
        branchFailedHard: false,
        improvedVsParent: false,
        improvedVsBaseline: true
      }
    ],
    error: null,
    illegal: false,
    timedOut: false,
    wallMs: 5,
    ...overrides
  };
}

describe("sessionsDir", () => {
  it("uses an explicit path first", () => {
    process.env.MAZE_SESSIONS_DIR = "/env/sessions";
    expect(sessionsDir("/explicit")).toBe("/explicit");
  });

  it("uses MAZE_SESSIONS_DIR when set", () => {
    process.env.MAZE_SESSIONS_DIR = join(dir, "env-sessions");
    expect(sessionsDir()).toBe(join(dir, "env-sessions"));
  });

  it("falls back to XDG_DATA_HOME, then the home data dir", () => {
    process.env.XDG_DATA_HOME = join(dir, "xdg");
    expect(sessionsDir()).toBe(join(dir, "xdg", "maze", "sessions"));
    delete process.env.XDG_DATA_HOME;
    expect(sessionsDir()).toContain(join("maze", "sessions"));
  });
});

describe("buildSession", () => {
  it("builds a session, executor, hooks and toolset, and records verify hooks", async () => {
    process.env.MAZE_SESSIONS_DIR = join(dir, "sessions");
    const built = await buildSession({
      model: "deepseek-chat",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k",
      verifyCommands: ["echo ok", "  ", "echo two"],
      permission: "allow"
    });
    expect(built.provider.model).toBe("deepseek-chat");
    expect(built.session.path).toContain(join("sessions"));
    expect(built.hooks.list().map((h) => h.name)).toEqual(["verify-1", "verify-2"]);
    expect(built.executor.context().workspaceDir).toBe(process.cwd());
    expect(built.tools.get("read")).toBeDefined();
    expect(built.cost.model).toBe("deepseek-chat");
    built.toolset.close();
  });
});

describe("developer/report", () => {
  it("builds a feedback report from a replay report", () => {
    const fb = buildFeedbackReport(tree(), report(), {
      beta1: 0.002,
      beta2: 0.01,
      normalize: "relativeToBaseline"
    });
    expect(fb.treeIndex).toBe(0);
    expect(fb.score).toBe(0.5);
    expect(fb.components.n).toBe(1);
    expect(fb.components.best).toBeCloseTo(0.2);
  });

  it("renders markdown with components, batches and revealed observations", () => {
    const text = renderFeedbackMarkdown("policy-x", [report()], [tree()], {
      beta1: 0.002,
      beta2: 0.01,
      normalize: "relativeToBaseline"
    });
    expect(text).toContain("# Replay feedback for policy-x");
    expect(text).toContain("beta1=0.002");
    expect(text).toContain("## Tree 0 (V = 0.5000)");
    expect(text).toContain("components: best=");
    expect(text).toContain("- batches:");
    expect(text).toContain("  - [a, b]");
    expect(text).toContain("- revealed:");
    expect(text).toContain("a branch=0 attempt=0 score=1.2000");
    expect(text).toContain("dB=0.2000");
    expect(text).toContain("dP=null");
  });

  it("renders the error line and non-finite scores", () => {
    const text = renderFeedbackMarkdown(
      "p",
      [report({ score: Number.NEGATIVE_INFINITY, error: "boom" })],
      [tree()],
      { beta1: 0, beta2: 0, normalize: "none" }
    );
    expect(text).toContain("- error: boom");
    expect(text).toContain("V = -Infinity");
  });

  it("skips reports whose tree is unknown", () => {
    const text = renderFeedbackMarkdown("p", [report({ treeIndex: 99 })], [tree(0)], {
      beta1: 0,
      beta2: 0,
      normalize: "none"
    });
    expect(text).not.toContain("## Tree 99");
  });

  it("formats hook feedback with and without output", () => {
    expect(formatHookFeedback([])).toBe("");
    expect(
      formatHookFeedback([{ name: "a", ok: true, output: "noise", timedOut: false }])
    ).not.toContain("noise");
    const fail = formatHookFeedback([{ name: "b", ok: false, output: "bad", timedOut: false }]);
    expect(fail).toContain("FAIL b");
    expect(fail).toContain("```\nbad\n```");
    expect(fail).toContain("Fix the failures");
  });
});

describe("developer/cli", () => {
  it("revises a policy through a scripted developer command", async () => {
    const promptPath = join(dir, "prompt.md");
    await writeFile(promptPath, "You are the policy developer.");
    const workDir = join(dir, "work");
    // The fake developer appends a marker to the policy file it is told to edit.
    const script = [
      "const fs = require('fs');",
      "const p = process.argv[process.argv.length - 1];",
      "const m = /policy file to edit is: (\\S+)/.exec(p);",
      "if (!m) process.exit(4);",
      "fs.appendFileSync(m[1], '\\n// revised\\n');"
    ].join("\n");
    const dev = new CliPolicyDeveloper({
      command: [process.execPath, "-e", script],
      promptPath,
      promptMode: "arg",
      workDir,
      timeoutMs: 20_000
    });
    const out = await dev.revise({
      currentPolicySource: "export default class P {}",
      replayReports: [report()],
      previousFeedback: ["be faster"],
      trees: [tree()]
    });
    expect(out).toContain("// revised");
    expect(await readFile(join(workDir, "rev-1", "policy.ts"), "utf8")).toContain("// revised");
    expect(await readFile(join(workDir, "rev-1", "feedback.md"), "utf8")).toContain("be faster");
  });

  it("derives feedback trees when none are supplied", async () => {
    const promptPath = join(dir, "prompt.md");
    await writeFile(promptPath, "p");
    const script = "process.exit(0)";
    const dev = new CliPolicyDeveloper({
      command: [process.execPath, "-e", script],
      promptPath,
      workDir: join(dir, "work2"),
      timeoutMs: 20_000
    });
    // No trees: the module synthesises them from the reports; the command still runs.
    expect(
      await dev.revise({
        currentPolicySource: "x",
        replayReports: [report()],
        previousFeedback: []
      })
    ).toBe("x");
  });

  it("reports a non-zero exit", async () => {
    const promptPath = join(dir, "prompt.md");
    await writeFile(promptPath, "p");
    const dev = new CliPolicyDeveloper({
      command: [process.execPath, "-e", "console.error('nope'); process.exit(3)"],
      promptPath,
      workDir: join(dir, "work3"),
      timeoutMs: 20_000
    });
    await expect(
      dev.revise({ currentPolicySource: "x", replayReports: [], previousFeedback: [] })
    ).rejects.toThrow(/exited 3/);
  });

  it("reports a timeout", async () => {
    const promptPath = join(dir, "prompt.md");
    await writeFile(promptPath, "p");
    const dev = new CliPolicyDeveloper({
      command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      promptPath,
      workDir: join(dir, "work4"),
      timeoutMs: 300
    });
    await expect(
      dev.revise({ currentPolicySource: "x", replayReports: [], previousFeedback: [] })
    ).rejects.toThrow(/timed out/);
  });

  it("uses the packaged prompt by default", async () => {
    const dev = new CliPolicyDeveloper({
      command: [process.execPath, "-e", "process.exit(0)"],
      workDir: join(dir, "work5"),
      timeoutMs: 20_000
    });
    // The default prompt file exists in the repo, so the run reaches the command.
    expect(
      await dev.revise({ currentPolicySource: "x", replayReports: [], previousFeedback: [] })
    ).toBe("x");
  });
});

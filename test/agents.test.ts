import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, CliAgent } from "../src/agents/cli.js";
import { ScriptedAgent } from "../src/agents/scripted.js";
import { ToolAgent } from "../src/agents/toolAgent.js";
import { ScriptedProvider } from "../src/agent/provider.js";
import { DEFAULT_PERMISSION_POLICY } from "../src/tools/permissions.js";
import type { AgentContext, ChatResult, DiscoveryNode, TaskSpec } from "../src/types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-agents-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const task: TaskSpec = {
  name: "t",
  description: "d",
  prompt: "Improve the program.",
  initProgramPath: dir,
  evaluatorCommand: [],
  evaluatorTimeoutMs: 1000,
  agentTimeoutMs: 1000
};

function ctx(nodeId = "n1", ancestorPath: AgentContext["ancestorPath"] = []): AgentContext {
  return { nodeId, branch: 0, attempt: 0, ancestorPath, taskPrompt: "Improve the program." };
}

function node(overrides: Partial<DiscoveryNode> = {}): DiscoveryNode {
  return {
    id: "p1",
    parentId: "root",
    branch: 0,
    attempt: 0,
    seq: 0,
    score: 1,
    valid: false,
    failClass: "runtime",
    error: "boom",
    diagnostics: null,
    snapshotRef: "root",
    artifactPath: null,
    cost: { agentCalls: 1, wallMs: 1 },
    createdAt: "now",
    ...overrides
  };
}

describe("runCli", () => {
  it("throws when the command is empty", async () => {
    await expect(
      runCli({ command: [], cwd: dir, prompt: "x", promptMode: "stdin", timeoutMs: 1000 })
    ).rejects.toThrow(/empty/);
  });

  it("pipes the prompt on stdin", async () => {
    const res = await runCli({
      command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
      cwd: dir,
      prompt: "hello stdin",
      promptMode: "stdin",
      timeoutMs: 10_000
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("hello stdin");
    expect(res.timedOut).toBe(false);
    expect(res.wallMs).toBeGreaterThanOrEqual(0);
  });

  it("passes the prompt as the last argument and forwards extra args", async () => {
    // Use a script file rather than `-e`: node would interpret `--flag` as its
    // own option instead of forwarding it to the script.
    const script = join(dir, "argv.mjs");
    await writeFile(script, "console.log(process.argv.slice(2).join('|'));\n");
    const res = await runCli({
      command: [process.execPath, script],
      cwd: dir,
      prompt: "the prompt",
      promptMode: "arg",
      extraArgs: ["--flag"],
      timeoutMs: 10_000
    });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("--flag|the prompt");
  });

  it("captures stdout, stderr and a non-zero exit code", async () => {
    const res = await runCli({
      command: [
        process.execPath,
        "-e",
        "console.log('out'); console.error('err'); process.exit(7)"
      ],
      cwd: dir,
      prompt: "",
      promptMode: "stdin",
      timeoutMs: 10_000
    });
    expect(res.code).toBe(7);
    expect(res.stdout).toBe("out\n");
    expect(res.stderr).toBe("err\n");
  });

  it("kills a command that exceeds the timeout", async () => {
    const res = await runCli({
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      cwd: dir,
      prompt: "",
      promptMode: "stdin",
      timeoutMs: 300
    });
    expect(res.timedOut).toBe(true);
    expect(res.code).not.toBe(0);
  }, 20_000);

  it("reports a missing binary as an error instead of throwing", async () => {
    const res = await runCli({
      command: ["definitely-not-a-real-binary-xyz"],
      cwd: dir,
      prompt: "",
      promptMode: "stdin",
      timeoutMs: 5000
    });
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain("ENOENT");
  }, 20_000);

  it("scrubs provider credentials from the child environment", async () => {
    const res = await runCli({
      command: [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({k: process.env.DREAM_API_KEY ?? null}))"
      ],
      cwd: dir,
      prompt: "",
      promptMode: "stdin",
      timeoutMs: 10_000,
      env: { DREAM_API_KEY: "should-not-leak" }
    });
    expect(res.stdout.trim()).toBe('{"k":null}');
  });
});

describe("CliAgent", () => {
  it("runs the command, writes a redacted transcript and returns its path", async () => {
    const agent = new CliAgent({
      command: [
        process.execPath,
        "-e",
        "const p=require('node:fs').readFileSync(0,'utf8'); console.log('saw ' + p.length + ' chars')"
      ],
      promptMode: "stdin",
      transcriptDir: join(dir, "transcripts")
    });
    const out = await agent.run({ workspaceDir: dir, task, parent: null, context: ctx() });
    expect(out.transcriptPath).toBe(join(dir, "transcripts", "n1.log"));
    const log = await readFile(out.transcriptPath!, "utf8");
    expect(log).toContain("# prompt");
    expect(log).toContain("# stdout");
    expect(log).toContain("saw ");
  }, 20_000);

  it("includes ancestor history and failure guidance in the prompt", async () => {
    const capture = new CliAgent({
      command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
      promptMode: "stdin",
      transcriptDir: join(dir, "t2")
    });
    const history = [
      {
        ...node({ id: "a1", valid: true, failClass: "ok", error: null, score: 2 }),
        deltaVsBaseline: 1,
        deltaVsParent: 1,
        nValid: null,
        nTotal: null,
        tags: [],
        branchPromising: true,
        branchFailedHard: false,
        improvedVsParent: true,
        improvedVsBaseline: true
      },
      {
        ...node({ id: "a2", valid: false, failClass: "runtime", error: "boom", score: null }),
        deltaVsBaseline: null,
        deltaVsParent: null,
        nValid: null,
        nTotal: null,
        tags: [],
        branchPromising: false,
        branchFailedHard: true,
        improvedVsParent: false,
        improvedVsBaseline: false
      }
    ];
    const out = await capture.run({
      workspaceDir: dir,
      task,
      parent: node(),
      context: ctx("n2", history)
    });
    const log = await readFile(out.transcriptPath!, "utf8");
    expect(log).toContain("History along this branch");
    expect(log).toContain("a2: score=null fail=runtime error=boom");
    expect(log).toContain("Repair the most recent failure");
  }, 20_000);

  it("throws on a non-zero exit and on a timeout", async () => {
    const failing = new CliAgent({
      command: [process.execPath, "-e", "console.error('nope'); process.exit(3)"]
    });
    await expect(
      failing.run({ workspaceDir: dir, task, parent: null, context: ctx() })
    ).rejects.toThrow(/exited 3: nope/);

    const slow = new CliAgent({
      command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 300
    });
    await expect(
      slow.run({ workspaceDir: dir, task, parent: null, context: ctx() })
    ).rejects.toThrow(/timed out/);
  }, 30_000);
});

describe("ScriptedAgent", () => {
  it("creates the program file, raises the value and bumps the generation", async () => {
    const agent = new ScriptedAgent({ seed: 1, failRate: 0, improvement: 1, noise: 0 });
    const out = await agent.run({ workspaceDir: dir, task, parent: null, context: ctx() });
    expect(out.tokens).toBe(100);
    const state = JSON.parse(await readFile(join(dir, "program.json"), "utf8"));
    expect(state.value).toBe(1);
    expect(state.generation).toBe(1);
  });

  it("is deterministic for the same seed and node", async () => {
    const run = async (nodeId: string) => {
      const d = await mkdtemp(join(tmpdir(), "dh-scripted-"));
      try {
        const agent = new ScriptedAgent({ seed: 42, failRate: 0, noise: 0.4 });
        await agent.run({ workspaceDir: d, task, parent: null, context: ctx(nodeId) });
        return JSON.parse(await readFile(join(d, "program.json"), "utf8")).value as number;
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    };
    expect(await run("n1")).toBe(await run("n1"));
    expect(await run("n1")).not.toBe(await run("n2"));
  });

  it("honours a custom program file and reads an existing state", async () => {
    await writeFile(join(dir, "state.json"), JSON.stringify({ value: 10, generation: 4 }));
    const agent = new ScriptedAgent({
      programFile: "state.json",
      failRate: 0,
      improvement: 2,
      noise: 0
    });
    await agent.run({ workspaceDir: dir, task, parent: null, context: ctx() });
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    expect(state.value).toBe(12);
    expect(state.generation).toBe(5);
  });

  it("writes a sentinel -1 when the simulated failure fires", async () => {
    const agent = new ScriptedAgent({ failRate: 1, improvement: 5 });
    await agent.run({ workspaceDir: dir, task, parent: null, context: ctx() });
    expect(JSON.parse(await readFile(join(dir, "program.json"), "utf8")).value).toBe(-1);
  });

  it("uses the half-improvement path for an invalid parent", async () => {
    await writeFile(join(dir, "program.json"), JSON.stringify({ value: 4, generation: 1 }));
    const agent = new ScriptedAgent({ failRate: 0, improvement: 2, noise: 0 });
    await agent.run({ workspaceDir: dir, task, parent: node({ valid: false }), context: ctx() });
    const state = JSON.parse(await readFile(join(dir, "program.json"), "utf8"));
    expect(state.value).toBe(5);
    expect(state.generation).toBe(2);
  });

  it("tolerates a corrupt program file", async () => {
    await writeFile(join(dir, "program.json"), "{not json");
    const agent = new ScriptedAgent({ failRate: 0, improvement: 1, noise: 0 });
    await agent.run({ workspaceDir: dir, task, parent: null, context: ctx() });
    const state = JSON.parse(await readFile(join(dir, "program.json"), "utf8"));
    expect(state.value).toBe(1);
    expect(state.generation).toBe(1);
  });
});

describe("ToolAgent", () => {
  function agent(turns: ChatResult[], maxTurns = 5): ToolAgent {
    return new ToolAgent({
      provider: new ScriptedProvider({ model: "scripted", turns }),
      permission: { ...DEFAULT_PERMISSION_POLICY, defaultAction: "allow" },
      runsDir: join(dir, "runs"),
      maxTurns,
      enableMcp: false
    });
  }

  it("runs an attempt, writes the transcript and returns token usage", async () => {
    const a = agent([
      {
        message: { role: "assistant", content: "done" },
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
        stopReason: "stop"
      }
    ]);
    const out = await a.run({
      workspaceDir: dir,
      task,
      parent: null,
      context: ctx()
    });
    expect(out.tokens).toBeGreaterThan(0);
    const log = await readFile(out.transcriptPath!, "utf8");
    expect(log).toContain("# stopReason done");
    expect(log).toContain("# system");
    expect(log).toContain("# messages");
  }, 30_000);

  it("renders branch history into the user prompt", async () => {
    const a = agent([
      {
        message: { role: "assistant", content: "ok" },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        stopReason: "stop"
      }
    ]);
    const out = await a.run({
      workspaceDir: dir,
      task,
      parent: node(),
      context: ctx("n9", [
        {
          ...node({ id: "h1", error: "old failure" }),
          deltaVsBaseline: 0,
          deltaVsParent: 0,
          nValid: null,
          nTotal: null,
          tags: [],
          branchPromising: false,
          branchFailedHard: true,
          improvedVsParent: false,
          improvedVsBaseline: false
        }
      ])
    });
    const log = await readFile(out.transcriptPath!, "utf8");
    expect(log).toContain("h1: score=1 fail=runtime error=old failure");
    expect(log).toContain("A previous attempt failed");
  }, 30_000);

  it("throws when the loop is detected", async () => {
    const repeated: ChatResult = {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", arguments: { path: "missing.txt" } }]
      },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      stopReason: "tool_calls"
    };
    const a = agent(
      Array.from({ length: 12 }, () => repeated),
      12
    );
    await expect(a.run({ workspaceDir: dir, task, parent: null, context: ctx() })).rejects.toThrow(
      /loop detected/
    );
  }, 60_000);
});

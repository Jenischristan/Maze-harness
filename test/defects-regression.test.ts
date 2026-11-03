import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session/store.js";
import { decide, isReDoSRisk, type PermissionPolicy } from "../src/tools/permissions.js";
import { webfetchTool, websearchTool } from "../src/tools/web.js";
import { parsePatch, applyFilePatch } from "../src/tools/patch.js";
import { readTool } from "../src/tools/read.js";
import { bashTool, resetShells } from "../src/tools/index.js";
import { pruneToolOutputs } from "../src/context/compaction.js";
import type { ChatMessage, ToolContext } from "../src/types.js";

let dir = "";
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-defects-"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.MAZE_SEARCH_URL;
  resetShells();
  await rm(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: dir,
    readFiles: new Set(),
    readHashes: new Map(),
    modifiedFiles: new Set(),
    maxOutputBytes: 32 * 1024,
    permission: {
      defaultAction: "allow",
      rules: [],
      networkEnabled: true,
      networkAllowlist: ["example.com"]
    },
    hooks: { register: () => undefined, list: () => [], runAll: async () => [] },
    ...overrides
  };
}

// F-01: duplicate entry ids must not make activeBranch()/projection() loop.
describe("F-01: session store survives duplicate ids and cycles", () => {
  it("does not crash when two tool calls share a model-supplied id", async () => {
    const store = new SessionStore({ dir, runId: "dup" });
    await store.init();
    await store.appendToolCall({ id: "dup", name: "bash", arguments: { command: "echo 1" } });
    await store.appendToolCall({ id: "dup", name: "bash", arguments: { command: "echo 2" } });
    expect(() => store.activeBranch()).not.toThrow();
    expect(() => store.projection()).not.toThrow();
    expect(store.activeBranch().length).toBeGreaterThanOrEqual(3);
  });

  it("truncates a branch whose entries form a parent cycle on disk", async () => {
    const header = {
      id: "hdr",
      parentId: null,
      kind: "header",
      timestamp: new Date().toISOString(),
      note: JSON.stringify({
        version: 1,
        runId: "cyc",
        model: "m",
        createdAt: new Date().toISOString(),
        cwd: "/"
      })
    };
    const a = {
      id: "a",
      parentId: "b",
      kind: "message",
      timestamp: "t",
      message: { role: "user", content: "a" }
    };
    const b = {
      id: "b",
      parentId: "a",
      kind: "message",
      timestamp: "t",
      message: { role: "user", content: "b" }
    };
    await writeFile(
      join(dir, "cyc.jsonl"),
      [header, a, b].map((e) => JSON.stringify(e)).join("\n") + "\n"
    );
    const store = new SessionStore({ dir, runId: "cyc" });
    await store.init();
    expect(() => store.activeBranch()).not.toThrow();
    expect(store.activeBranch().length).toBeLessThanOrEqual(2);
  });

  it("truncates the branch when a parentId points at a missing entry", async () => {
    const header = { id: "hdr", parentId: null, kind: "header", timestamp: "t", note: "{}" };
    const orphan = {
      id: "m1",
      parentId: "ghost",
      kind: "message",
      timestamp: "t",
      message: { role: "user", content: "x" }
    };
    await writeFile(
      join(dir, "orphan.jsonl"),
      [header, orphan].map((e) => JSON.stringify(e)).join("\n") + "\n"
    );
    const store = new SessionStore({ dir, runId: "orphan" });
    await store.init();
    expect(store.activeBranch().map((e) => e.kind)).toEqual(["message"]);
    expect(store.projection()).toHaveLength(1);
  });
});

// F-02: webfetch must re-check the network allowlist on every redirect hop.
describe("F-02: webfetch redirects re-check the allowlist", () => {
  it("denies a redirect to a host outside the allowlist", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("/start")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/secret" }
        });
      }
      return new Response("INTERNAL", { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    const res = await webfetchTool.execute({ url: "https://example.com/start" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("network-denied");
    expect(res.content).toContain("127.0.0.1");
  });

  it("follows same-host redirects and reports the final body", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("/start")) {
        return new Response(null, { status: 301, headers: { location: "/final" } });
      }
      return new Response("FINAL", { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    const res = await webfetchTool.execute({ url: "https://example.com/start" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toBe("FINAL");
  });

  it("stops after too many redirects instead of looping forever", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://example.com/loop" } })
    ) as unknown as typeof fetch;
    const res = await webfetchTool.execute({ url: "https://example.com/loop" }, ctx());
    expect(res.error).toBe("too-many-redirects");
  });
});

// F-03: config-supplied rule patterns must not be able to block the event loop.
describe("F-03: permission patterns are bounded", () => {
  it("flags nested-quantifier patterns as a ReDoS risk", () => {
    expect(isReDoSRisk("^(a+)+$")).toBe(true);
    expect(isReDoSRisk("(a|aa)*$")).toBe(true);
    expect(isReDoSRisk("(\\d*)*")).toBe(true);
    expect(isReDoSRisk("^rm\\b.*-r")).toBe(false);
    expect(isReDoSRisk("^(a+)$")).toBe(false);
    expect(isReDoSRisk("(ab)+")).toBe(false);
  });

  it("returns immediately on a catastrophic pattern instead of hanging", async () => {
    const subject = `${"a".repeat(30)}!`;
    const start = Date.now();
    const decision = await decide(
      {
        defaultAction: "allow",
        rules: [{ tool: "*", pattern: "^(a+)+$", action: "deny" }]
      } as PermissionPolicy,
      "bash",
      { command: subject }
    );
    expect(Date.now() - start).toBeLessThan(1000);
    // A rejected rule is treated as a non-match, which leaves the default.
    expect(decision.action).toBe("allow");
  });

  it("still applies ordinary patterns", async () => {
    const decision = await decide(
      {
        defaultAction: "allow",
        rules: [{ tool: "bash", pattern: "\\bdrop\\b", action: "deny" }]
      } as PermissionPolicy,
      "bash",
      { command: "psql -c 'drop table t'" }
    );
    expect(decision.action).toBe("deny");
  });

  it("treats an invalid regex as a non-match without throwing", async () => {
    const decision = await decide(
      {
        defaultAction: "allow",
        rules: [{ tool: "bash", pattern: "([", action: "deny" }]
      } as PermissionPolicy,
      "bash",
      { command: "ls" }
    );
    expect(decision.action).toBe("allow");
  });
});

// F-04: a malformed MAZE_SEARCH_URL is reported, not thrown.
describe("F-04: websearch reports a bad endpoint", () => {
  it("returns bad-endpoint instead of throwing", async () => {
    process.env.MAZE_SEARCH_URL = "not a url";
    const res = await websearchTool.execute({ query: "x" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bad-endpoint");
  });
});

// F-05: a persistent shell command that exits must not look successful.
describe("F-05: persistent bash reports shell exit as a failure", () => {
  it("marks `exit N` as shell-exited and non-ok", async () => {
    const res = await bashTool.execute({ command: "exit 7" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("shell-exited");
    expect((res.data as { exitCode: number | null }).exitCode).toBeNull();
  });

  it("still recovers on the next command", async () => {
    await bashTool.execute({ command: "exit 7" }, ctx());
    const res = await bashTool.execute({ command: "echo alive" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content.trim()).toBe("alive");
  });

  it("reports a normal non-zero exit code", async () => {
    const res = await bashTool.execute({ command: "false" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("exit 1");
  });
});

// F-06: add-file patches preserve a leading blank line.
describe("F-06: add-file patches keep leading blank lines", () => {
  const add = (lines: string[]): string =>
    ["*** Begin Patch", "*** Add File: f.txt", ...lines, "*** End Patch"].join("\n");

  it("keeps a leading empty line", () => {
    expect(applyFilePatch("", parsePatch(add(["", "a"]))[0]!)).toBe("\na");
  });

  it("keeps interior and trailing empty lines", () => {
    expect(applyFilePatch("", parsePatch(add(["a", "", "b"]))[0]!)).toBe("a\n\nb");
    expect(applyFilePatch("", parsePatch(add(["a", ""]))[0]!)).toBe("a\n");
  });

  it("does not invent blank lines", () => {
    expect(applyFilePatch("", parsePatch(add(["a", "b"]))[0]!)).toBe("a\nb");
  });
});

// F-07: BOM-marked UTF-16 text is readable instead of "binary".
describe("F-07: UTF-16 text files are readable", () => {
  it("reads UTF-16LE with a BOM", async () => {
    const path = join(dir, "le.txt");
    await writeFile(
      path,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello", "utf16le")])
    );
    const res = await readTool.execute({ path: "le.txt" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("hello");
  });

  it("reads UTF-16BE with a BOM", async () => {
    const path = join(dir, "be.txt");
    const body = Buffer.from("hello", "utf16le");
    body.swap16();
    await writeFile(path, Buffer.concat([Buffer.from([0xfe, 0xff]), body]));
    const res = await readTool.execute({ path: "be.txt" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("hello");
  });

  it("still refuses genuine binary files", async () => {
    await writeFile(join(dir, "x.bin"), Buffer.from([0x61, 0x00, 0x62]));
    const res = await readTool.execute({ path: "x.bin" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("binary-file");
  });
});

// F-08: pruning a tool output must not leave a dangling page reference behind.
describe("F-08: pruned tool output drops stale truncation metadata", () => {
  it("replaces old tool output and removes the page pointer", () => {
    const messages = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "t", name: "bash", arguments: {} }] },
      {
        role: "tool",
        content: "x".repeat(4000),
        toolCallId: "t",
        name: "bash",
        truncated: { keptBytes: 100, droppedBytes: 3900, pageToken: "deadbeef" }
      },
      { role: "assistant", content: "done" }
    ] as ChatMessage[];
    const { messages: out, pruned } = pruneToolOutputs(messages, {
      minTokens: 800,
      keepRecentTokens: 1
    });
    expect(pruned).toBe(1);
    const tool = out[2] as ChatMessage & { truncated?: unknown };
    expect(tool.content).toContain("pruned by compaction");
    expect(tool.truncated).toBeUndefined();
  });
});

// F-13: forking a session at an entry must include that entry.
describe("F-13: session fork points are inclusive", () => {
  it("keeps the fork message instead of dropping it", async () => {
    const store = new SessionStore({ dir, runId: "src" });
    await store.init();
    const first = await store.appendMessage({ role: "user", content: "hello" });
    await store.appendMessage({ role: "assistant", content: "hi" });
    const { cloneSession } = await import("../src/session/lifecycle.js");
    expect(
      (await cloneSession(dir, "src", "fork", { at: first.id })).projection().map((m) => m.content)
    ).toEqual(["hello"]);
  });
});

// F-14: an evaluator that prints a JSON array must be rejected as malformed,
// not reported as a legitimate "incorrect" result.
describe("F-14: evaluator rejects non-object JSON", () => {
  it("flags a JSON array payload as a runtime error", async () => {
    const { CommandEvaluator } = await import("../src/evaluator.js");
    const ev = new CommandEvaluator({
      command: [process.execPath, "-e", 'console.log("[1,2]")'],
      timeoutMs: 10_000,
      cwd: dir
    });
    const res = await ev.evaluate(dir);
    expect(res.failClass).toBe("runtime");
    expect(res.error).toBe("evaluator JSON must be an object");
  });
});

// F-15: an observed prompt-token count must not mask a large tool result
// appended after that request.
describe("F-15: shouldCompact considers the current estimate", () => {
  it("compacts when the estimate exceeds the threshold even if the last prompt was small", async () => {
    const { shouldCompact } = await import("../src/context/compaction.js");
    const cfg = { contextWindow: 64_000, reserveTokens: 16_384, keepRecentTokens: 20_000 };
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "tool", content: "z".repeat(200_000), toolCallId: "a", name: "big" }
    ] as ChatMessage[];
    expect(shouldCompact(messages, cfg, 50)).toBe(true);
    expect(shouldCompact([{ role: "user", content: "hi" }], cfg, 50)).toBe(false);
  });
});

// F-16: one oversized tool result must still be compacted.
describe("F-16: a single oversized tool result is compacted", () => {
  it("summarises and drops a tool result bigger than keepRecentTokens", async () => {
    const { compact } = await import("../src/context/compaction.js");
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "big", arguments: {} }] },
      { role: "tool", content: "z".repeat(200_000), toolCallId: "a", name: "big" }
    ] as ChatMessage[];
    const res = await compact(
      messages,
      { summarize: async () => "S" },
      { contextWindow: 64_000, reserveTokens: 16_384, keepRecentTokens: 20_000 }
    );
    expect(res.compactedCount).toBeGreaterThan(0);
    expect(res.firstKeptIndex).toBeLessThan(messages.length);
    expect(res.messages.filter((m) => !m.compacted).length).toBeLessThan(messages.length);
  });
});

// F-17: a policy bundle that compiles but default-exports a non-class must fail
// with the actionable compile message, not an opaque TypeError.
describe("F-17: runDream rejects a non-class policy export", () => {
  it("reports a compile failure for a literal default export", async () => {
    const { runDream } = await import("../src/loop/dream.js");
    const { CommandEvaluator } = await import("../src/evaluator.js");
    const { ScriptedAgent } = await import("../src/agents/scripted.js");
    const toy = join(process.cwd(), "examples/toy-task");
    await expect(
      runDream({
        runId: "nonclass",
        repoDir: join(dir, "repo"),
        task: {
          name: "toy",
          description: "d",
          prompt: "p",
          initProgramPath: join(toy, "init"),
          evaluatorCommand: ["python3", join(toy, "evaluator/evaluate.py"), "{workspace}"],
          evaluatorTimeoutMs: 20000,
          agentTimeoutMs: 20000
        },
        agent: new ScriptedAgent({ seed: 1, failRate: 0 }),
        evaluator: new CommandEvaluator({
          command: ["python3", join(toy, "evaluator/evaluate.py"), "{workspace}"],
          timeoutMs: 20000
        }),
        developer: { revise: async () => "export default 5;" },
        seedPolicy: { policyId: "bad", source: "export default 5;" },
        rounds: 1,
        revisions: 0,
        maxParallelism: 1,
        roundsLimit: 1,
        scoreConfig: { beta1: 0, beta2: 0, normalize: "none" },
        betaGrid: null,
        sandbox: { timeoutMs: 20000, memoryMb: 256 },
        runRoot: dir,
        mode: "fixed"
      } as never)
    ).rejects.toThrow(/failed to compile/);
  }, 120_000);
});

// F-18: single-quoted frontmatter values must not keep their quotes.
describe("F-18: skill frontmatter strips single quotes", () => {
  it("parses a single-quoted description without the quotes", async () => {
    const { discoverSkills } = await import("../src/skills.js");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "skills", "quoted"), { recursive: true });
    await writeFile(
      join(dir, "skills", "quoted", "SKILL.md"),
      "---\nname: 'q'\ndescription: 'desc'\n---\nbody\n"
    );
    const [skill] = await discoverSkills(dir);
    expect(skill).toMatchObject({ name: "q", description: "desc" });
  });
});

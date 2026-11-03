import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseSessionArgs,
  sessionLines,
  cloneSession,
  renameSession,
  deleteSession,
  resumeSession,
  projectionToBlocks
} from "../src/session/lifecycle.js";
import { SessionStore } from "../src/session/store.js";
import {
  configureLogging,
  configureLoggingFromEnv,
  addLogSink,
  currentLogLevel,
  withLogContext,
  getLogger
} from "../src/util/logger.js";
import { formatHookFeedback, makeDefaultHooks, writeTranscript } from "../src/agent/verify.js";
import { readRun, listRuns, bestScore, renderComparison } from "../src/runs/report.js";
import { buildAgentToolset, skillsPrompt, agentsPrompt } from "../src/registry.js";
import {
  splitModel,
  expandValue,
  findConfigFile,
  loadFileConfig,
  resolveConfig,
  contextPct
} from "../src/config.js";
import type { DiscoveryTree } from "../src/types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-infra-"));
});

afterEach(async () => {
  configureLogging({ level: "info", format: "text" });
  await rm(dir, { recursive: true, force: true });
});

describe("session lifecycle: argument parsing", () => {
  it("defaults to list", () => {
    expect(parseSessionArgs("")).toEqual({ action: "list" });
    expect(parseSessionArgs("   ")).toEqual({ action: "list" });
  });

  it("parses every verb, including aliases", () => {
    expect(parseSessionArgs("new my session")).toEqual({ action: "new", name: "my session" });
    expect(parseSessionArgs("clone abc")).toEqual({ action: "clone", id: "abc" });
    expect(parseSessionArgs("fork abc m-1")).toEqual({ action: "fork", id: "abc", at: "m-1" });
    expect(parseSessionArgs("resume abc")).toEqual({ action: "resume", id: "abc" });
    expect(parseSessionArgs("name renamed")).toEqual({ action: "name", name: "renamed" });
    expect(parseSessionArgs("delete abc")).toEqual({ action: "delete", id: "abc" });
    expect(parseSessionArgs("rm abc")).toEqual({ action: "delete", id: "abc" });
    expect(parseSessionArgs("ls")).toEqual({ action: "list" });
    expect(parseSessionArgs("list")).toEqual({ action: "list" });
  });

  it("treats a bare id as a resume", () => {
    expect(parseSessionArgs("abc123")).toEqual({ action: "resume", id: "abc123" });
  });
});

describe("session lifecycle: operations", () => {
  async function seed(id = "one"): Promise<SessionStore> {
    const s = new SessionStore({ dir, runId: id });
    await s.init();
    await s.appendMessage({ role: "user", content: "hello" });
    await s.appendMessage({ role: "assistant", content: "hi" });
    await s.recordUsage({ promptTokens: 1, completionTokens: 1, totalTokens: 2, usd: 0.5 });
    return s;
  }

  it("lists sessions with an active marker and totals", async () => {
    await seed("one");
    await seed("two");
    const lines = await sessionLines(dir, "one");
    expect(lines.map((l) => l.runId).sort()).toEqual(["one", "two"]);
    const one = lines.find((l) => l.runId === "one")!;
    expect(one.active).toBe(true);
    expect(one.messageCount).toBe(2);
    expect(one.tokens).toBe(2);
    expect(one.usd).toBe(0.5);
    expect(lines.find((l) => l.runId === "two")!.active).toBe(false);
  });

  it("returns no lines for a missing directory", async () => {
    expect(await sessionLines(join(dir, "nope"), null)).toEqual([]);
  });

  it("clones a session into a new id with a copied transcript", async () => {
    await seed("one");
    const clone = await cloneSession(dir, "one", "clone");
    expect(clone.path).not.toContain("one.jsonl");
    expect(clone.projection().map((m) => m.content)).toEqual(["hello", "hi"]);
    expect(clone.meta.name).toBeUndefined();
    expect(clone.meta.runId).toMatch(/^session-/);
  });

  it("forks a session at an entry id", async () => {
    const src = await seed("one");
    const first = src.activeBranch().find((e) => e.kind === "message")!;
    const last = src
      .activeBranch()
      .filter((e) => e.kind === "message")
      .at(-1)!;
    // inclusive: forking at the first message keeps exactly that message
    expect(
      (await cloneSession(dir, "one", "fork", { at: first.id })).projection().map((m) => m.content)
    ).toEqual(["hello"]);
    expect(
      (await cloneSession(dir, "one", "fork", { at: last.id })).projection().map((m) => m.content)
    ).toEqual(["hello", "hi"]);
  });

  it("refuses to clone a missing session", async () => {
    await expect(cloneSession(dir, "ghost", "clone")).rejects.toThrow(/not found/);
  });

  it("renames a session and rejects a missing one", async () => {
    await seed("one");
    expect(await renameSession(dir, "one", "renamed")).toBe("renamed");
    const lines = await sessionLines(dir, null);
    expect(lines[0]!.name).toBe("renamed");
    await expect(renameSession(dir, "ghost", "x")).rejects.toThrow(/not found/);
  });

  it("deletes a session and rejects a missing one", async () => {
    await seed("one");
    await deleteSession(dir, "one");
    expect(await sessionLines(dir, null)).toEqual([]);
    await expect(deleteSession(dir, "ghost")).rejects.toThrow(/not found/);
  });

  it("resumes a session with its history", async () => {
    await seed("one");
    const store = await resumeSession(dir, "one");
    expect(store.projection().map((m) => m.role)).toEqual(["user", "assistant"]);
    await expect(resumeSession(dir, "ghost")).rejects.toThrow(/not found/);
  });

  it("projects a session into content blocks", async () => {
    const store = await seed("one");
    const blocks = projectionToBlocks(store.projection());
    expect(blocks).toEqual([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "hi" }
    ]);
  });
});

describe("logger", () => {
  it("filters by level and defaults unknown levels to info", () => {
    const records: any[] = [];
    const off = addLogSink((r) => records.push(r));
    configureLogging({ level: "warn" });
    expect(currentLogLevel()).toBe("warn");
    getLogger("t").debug("d");
    getLogger("t").info("i");
    getLogger("t").warn("w");
    getLogger("t").error("e");
    expect(records.map((r) => r.message)).toEqual(["w", "e"]);
    configureLogging({ level: "nonsense" });
    expect(currentLogLevel()).toBe("info");
    off();
  });

  it("removes a sink and falls back to stderr when none remain", () => {
    const records: any[] = [];
    const off = addLogSink((r) => records.push(r));
    getLogger("t").info("one");
    off();
    getLogger("t").info("two");
    expect(records.map((r) => r.message)).toEqual(["one"]);
  });

  it("redacts secret-looking fields and nested values", () => {
    const records: any[] = [];
    const off = addLogSink((r) => records.push(r));
    getLogger("t").info("m", { apiKey: "abc", nested: { token: "x" }, ok: "fine" });
    expect(records[0].apiKey).toBe("[REDACTED]");
    expect(records[0].ok).toBe("fine");
    off();
  });

  it("drops undefined fields and serialises json", () => {
    const records: any[] = [];
    const off = addLogSink((r) => records.push(r));
    configureLogging({ format: "json" });
    getLogger("t").info("m", { skipped: undefined, n: 2 });
    expect(records[0].skipped).toBeUndefined();
    expect(records[0].n).toBe(2);
    off();
  });

  it("nests context and restores it after the callback", async () => {
    const records: any[] = [];
    const off = addLogSink((r) => records.push(r));
    await withLogContext({ runId: "r1" }, async () => {
      getLogger("t").info("inner");
    });
    getLogger("t").info("outer");
    expect(records[0].runId).toBe("r1");
    expect(records[1].runId).toBeUndefined();
    off();
  });

  it("restores context even when the callback throws", async () => {
    await expect(
      withLogContext({ runId: "r1" }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });

  it("reads level and format from the environment", () => {
    configureLoggingFromEnv({ DREAM_LOG_LEVEL: "error", DREAM_LOG_FORMAT: "json" } as any);
    expect(currentLogLevel()).toBe("error");
    configureLogging({ level: "info", format: "text" });
    configureLoggingFromEnv({} as any);
    expect(currentLogLevel()).toBe("info");
  });

  it("child loggers merge their fields", () => {
    const records: any[] = [];
    const off = addLogSink((r) => records.push(r));
    getLogger("t", { a: 1 }).child({ b: 2 }).info("m");
    expect(records[0]).toMatchObject({ a: 1, b: 2 });
    off();
  });
});

describe("agent/verify helpers", () => {
  it("renders nothing for an empty result set", () => {
    expect(formatHookFeedback([])).toBe("");
  });

  it("renders pass, fail, timeouts and failure guidance", () => {
    const text = formatHookFeedback([
      { name: "a", ok: true, output: "", timedOut: false },
      { name: "b", ok: false, output: "trace", timedOut: true }
    ]);
    expect(text).toContain("PASS a");
    expect(text).toContain("FAIL b (timed out)");
    expect(text).toContain("trace");
    expect(text).toContain("Fix the failures");
  });

  it("omits the guidance when everything passes", () => {
    const text = formatHookFeedback([{ name: "a", ok: true, output: "", timedOut: false }]);
    expect(text).not.toContain("Fix the failures");
  });

  it("builds default hooks that run and report", async () => {
    const hooks = makeDefaultHooks(["echo ok", "exit 2"], { workspaceDir: dir, timeoutMs: 5000 });
    const results = await hooks.runAll();
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["verify-1", true],
      ["verify-2", false]
    ]);
  });

  it("writes a transcript into a nested directory", async () => {
    const path = await writeTranscript(join(dir, "a", "b"), "t.txt", "body");
    expect(await readFile(path, "utf8")).toBe("body");
  });
});

describe("runs/report", () => {
  async function writeRun(
    id: string,
    mode: string | undefined,
    scores: Array<number | null>
  ): Promise<void> {
    const runDir = join(dir, id);
    await mkdir(join(runDir, "trees"), { recursive: true });
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        ...(mode ? { mode } : {}),
        results: [
          { round: 1, meanScore: 0.1, cumulativeCalls: 5, treeIndex: 0 },
          { round: 2, meanScore: 0.2, cumulativeCalls: 9, treeIndex: 1 }
        ]
      })
    );
    const tree: DiscoveryTree = {
      runId: id,
      treeIndex: 0,
      baselineScore: 1,
      maxParallelism: 2,
      roundsLimit: 3,
      policyId: "p",
      createdAt: "t",
      nodes: scores.map((score, i) => ({
        id: `n${i}`,
        parentId: "",
        branch: 0,
        attempt: 0,
        seq: i,
        score,
        valid: true,
        failClass: "ok",
        error: null,
        diagnostics: null,
        snapshotRef: "",
        artifactPath: null,
        cost: { agentCalls: 1, wallMs: 1 },
        createdAt: "t"
      }))
    };
    await writeFile(join(runDir, "trees", "0.json"), JSON.stringify(tree));
  }

  it("reads a run with its best score and totals", async () => {
    await writeRun("run-a", "dream", [1, 5, null]);
    const run = await readRun(dir, "run-a");
    expect(run).toMatchObject({ runId: "run-a", mode: "dream", bestScore: 5, totalCalls: 9 });
    expect(run!.rounds).toHaveLength(2);
  });

  it("returns null for a missing or corrupt state file", async () => {
    expect(await readRun(dir, "ghost")).toBeNull();
    await mkdir(join(dir, "bad"));
    await writeFile(join(dir, "bad", "state.json"), "{nope");
    expect(await readRun(dir, "bad")).toBeNull();
  });

  it("infers the mode from the run id when not recorded", async () => {
    await writeRun("dream-1", undefined, [1]);
    await writeRun("fixed-1", undefined, [1]);
    expect((await readRun(dir, "dream-1"))!.mode).toBe("dream");
    expect((await readRun(dir, "fixed-1"))!.mode).toBe("fixed");
  });

  it("lists runs sorted by name and skips directories without state", async () => {
    await writeRun("b-run", "fixed", [1]);
    await writeRun("a-run", "fixed", [2]);
    await mkdir(join(dir, "c-empty"), { recursive: true });
    expect((await listRuns(dir)).map((r) => r.runId)).toEqual(["a-run", "b-run"]);
  });

  it("returns no runs when the directory is missing", async () => {
    expect(await listRuns(join(dir, "nope"))).toEqual([]);
  });

  it("bestScore ignores corrupt trees and null scores", async () => {
    await mkdir(join(dir, "trees"), { recursive: true });
    await writeFile(join(dir, "trees", "bad.json"), "{nope");
    expect(await bestScore(join(dir, "trees"))).toBeNull();
    expect(await bestScore(join(dir, "missing"))).toBeNull();
  });

  it("renders a comparison table and an empty message", async () => {
    expect(renderComparison([])).toBe("no runs found");
    await writeRun("d1", "dream", [3]);
    await writeRun("f1", "fixed", [2]);
    const text = renderComparison(await listRuns(dir));
    expect(text).toContain("d1");
    expect(text).toContain("f1");
    expect(text).toContain("mean best=");
    expect(text).toContain("best score vs cumulative agent calls");
  });
});

describe("registry extras", () => {
  it("renders the skills prompt, including the empty case", () => {
    expect(skillsPrompt([])).toBe("");
    const text = skillsPrompt([{ name: "s", description: "d" } as any]);
    expect(text).toContain("- s: d");
    expect(text).toContain("/skill <name>");
  });

  it("renders only user-defined subagents", () => {
    expect(agentsPrompt([])).toBe("");
    const text = agentsPrompt([
      { name: "custom", description: "cd", mode: "subagent", source: "file" } as any,
      { name: "builtin", description: "bd", mode: "subagent", source: "builtin" } as any
    ]);
    expect(text).toContain("- custom: cd");
    expect(text).not.toContain("builtin");
  });

  it("registers network and delegate tools but can skip both", async () => {
    const full = await buildAgentToolset({
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k"
    });
    expect(full.registry.get("delegate")).toBeDefined();
    expect(full.registry.get("fetch")).toBeDefined();
    full.close();
    const bare = await buildAgentToolset({
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k",
      enableDelegate: false,
      enableMcp: false
    });
    expect(bare.registry.get("delegate")).toBeUndefined();
    bare.close();
  });

  it("skips disabled, remote and hidden MCP entries from config", async () => {
    const set = await buildAgentToolset({
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k",
      enableMcp: true,
      mcpConfig: {
        _hidden: { command: "x" },
        off: { command: "x", enabled: false },
        remote: { type: "remote", url: "http://x" },
        empty: {},
        bad: { command: [] as any }
      }
    });
    expect(set.mcpClients).toEqual([]);
    set.close();
  });
});

describe("config extras", () => {
  it("expands env and file tokens with graceful misses", async () => {
    await writeFile(join(dir, "secret.txt"), "  from-file\n");
    expect(expandValue("{env:MY_VAR}", dir, { MY_VAR: "v" } as any)).toBe("v");
    expect(expandValue("{env:MISSING}", dir, {} as any)).toBe("");
    expect(expandValue("{file:secret.txt}", dir)).toBe("from-file");
    expect(expandValue("{file:nope.txt}", dir)).toBe("");
  });

  it("splits provider-qualified model ids", () => {
    expect(splitModel("anthropic/claude")).toEqual({ provider: "anthropic", model: "claude" });
    expect(splitModel("a/b/c")).toEqual({ provider: "a", model: "b/c" });
    expect(splitModel("plain")).toEqual({ model: "plain" });
    expect(splitModel("/leading")).toEqual({ model: "/leading" });
  });

  it("finds MAZE_CONFIG first and then the standard names", async () => {
    await writeFile(join(dir, "maze.json"), "{}");
    expect(findConfigFile(dir, {} as any)).toBe(join(dir, "maze.json"));
    await writeFile(join(dir, "custom.json"), "{}");
    expect(findConfigFile(dir, { MAZE_CONFIG: join(dir, "custom.json") } as any)).toBe(
      join(dir, "custom.json")
    );
    const empty = await mkdtemp(join(tmpdir(), "dh-cfg-"));
    try {
      expect(findConfigFile(empty, {} as any)).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("expands tokens inside a loaded file config", async () => {
    await writeFile(join(dir, "key.txt"), "secret");
    await writeFile(
      join(dir, "maze.json"),
      JSON.stringify({ provider: { p: { apiKey: "{file:key.txt}" } } })
    );
    const { config, path } = loadFileConfig(dir, {} as any);
    expect(path).toBe(join(dir, "maze.json"));
    expect(config.provider!.p!.apiKey).toBe("secret");
  });

  it("returns an empty config for a non-object file", async () => {
    await writeFile(join(dir, "maze.json"), "null");
    expect(loadFileConfig(dir, {} as any).config).toEqual({});
  });

  it("resolves provider model overrides and API keys with precedence", async () => {
    await writeFile(
      join(dir, "maze.json"),
      JSON.stringify({
        model: "p/m",
        provider: { p: { apiKey: "file-key", models: { m: { contextWindow: 999 } } } }
      })
    );
    const fromFile = resolveConfig({}, {} as any, dir);
    expect(fromFile.apiKey).toBe("file-key");
    expect(fromFile.contextWindow).toBe(999);
    expect(resolveConfig({}, { DREAM_API_KEY: "env-key" } as any, dir).apiKey).toBe("env-key");
    expect(resolveConfig({ apiKey: "flag-key" }, {} as any, dir).apiKey).toBe("flag-key");
  });

  it("accepts the DEEPSEEK_ROUTER_KEY and OPENAI_API_KEY fallbacks", async () => {
    expect(resolveConfig({}, { DEEPSEEK_ROUTER_KEY: "d" } as any, dir).apiKey).toBe("d");
    expect(resolveConfig({}, { OPENAI_API_KEY: "o" } as any, dir).apiKey).toBe("o");
    expect(resolveConfig({}, {} as any, dir).apiKey).toBeUndefined();
  });

  it("rejects a non-positive context window env value", () => {
    expect(() => resolveConfig({}, { DREAM_CONTEXT_WINDOW: "-1" } as any, dir)).toThrow(
      /positive number/
    );
  });

  it("ignores an invalid flag context window", () => {
    expect(resolveConfig({ contextWindow: -5 }, {} as any, dir).contextWindow).toBeGreaterThan(0);
  });

  it("computes context percentages safely", () => {
    expect(contextPct(0, 100)).toBe(0);
    expect(contextPct(50, 100)).toBe(0.5);
    expect(contextPct(200, 100)).toBe(1);
    expect(contextPct(10, 0)).toBe(0);
  });
});

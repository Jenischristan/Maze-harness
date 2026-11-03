import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills, findSkill, skillPrompt, skillLines } from "../src/skills.js";
import {
  discoverAgents,
  findAgent,
  toolsForAgent,
  parseAgentFrontmatter,
  resolveSkillMentions,
  loadSkills
} from "../src/agents/definitions.js";
import { buildAgentToolset, skillsPrompt, agentsPrompt } from "../src/registry.js";
import {
  environmentBlock,
  modelPromptSection,
  buildSystemPrompt,
  promptDirPath
} from "../src/agent/prompts.js";
import { loadMcpConfig, loadProjectMcpConfig, mcpSummary } from "../src/mcp.js";
import { sessionsDir } from "../src/chat.js";
import { FileGoalStore, goalSection } from "../src/goals.js";
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
  await rm(dir, { recursive: true, force: true });
});

describe("skills", () => {
  async function seedSkill(rel: string, content: string): Promise<void> {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  it("discovers SKILL.md files with frontmatter and derives a fallback name", async () => {
    await seedSkill(
      ".dream/skills/cpp/SKILL.md",
      "---\nname: cpp-large-project\ndescription: C++ guidance\nallowed-tools: [read, grep, edit]\n---\n\n# Cpp\n\nDo C++ things.\n"
    );
    await seedSkill("skills/plain.md", "Just a body with no frontmatter.\n");
    const skills = await discoverSkills(dir);
    const names = skills.map((s) => s.name);
    expect(names).toContain("cpp-large-project");
    expect(names).toContain("plain");
    const cpp = skills.find((s) => s.name === "cpp-large-project")!;
    expect(cpp.description).toBe("C++ guidance");
    expect(cpp.allowedTools).toEqual(["read", "grep", "edit"]);
    expect(cpp.body).toContain("Do C++ things.");
  });

  it("skips empty bodies and de-duplicates by name", async () => {
    await seedSkill(".dream/skills/a/SKILL.md", "---\nname: dup\n---\n\nbody one\n");
    await seedSkill(".claude/skills/b/SKILL.md", "---\nname: dup\n---\n\nbody two\n");
    await seedSkill(".dream/skills/empty/SKILL.md", "---\nname: empty\n---\n\n   \n");
    const skills = await discoverSkills(dir);
    expect(skills.filter((s) => s.name === "dup")).toHaveLength(1);
    expect(skills.some((s) => s.name === "empty")).toBe(false);
  });

  it("resolves skills by exact name, then unique prefix", async () => {
    await seedSkill("skills/report/SKILL.md", "---\nname: report\n---\n\nbody\n");
    await seedSkill("skills/reporter/SKILL.md", "---\nname: reporter\n---\n\nbody\n");
    const skills = await discoverSkills(dir);
    expect(findSkill(skills, "report")!.name).toBe("report");
    expect(findSkill(skills, "REPOR")!.name).toBe("report");
    expect(findSkill(skills, "nope")).toBeNull();
    expect(findSkill(skills, "  ")).toBeNull();
    expect(skillPrompt(findSkill(skills, "report")!)).toContain("# Skill: report");
    expect(skillLines([], 80)[0]).toContain("no skills found");
    expect(skillLines(skills, 80).join("\n")).toContain("/skill report");
  });

  it("loadSkills returns [] when discovery throws", async () => {
    // A path that is a file, not a directory, cannot be scanned.
    await writeFile(join(dir, ".dream"), "not a dir");
    await expect(loadSkills(dir)).resolves.toEqual([]);
  });
});

describe("agent definitions", () => {
  it("parses frontmatter including nested permissions and tool lists", () => {
    const raw = [
      "---",
      "description: A reviewer",
      "mode: subagent",
      "model: deepseek-chat",
      "max-turns: 12",
      "tools: [read, grep]",
      "permission:",
      "  bash: deny",
      "  edit: ask",
      "---",
      "",
      "# Reviewer body",
      ""
    ].join("\n");
    const { meta, body } = parseAgentFrontmatter(raw);
    expect(meta.description).toBe("A reviewer");
    expect(meta.mode).toBe("subagent");
    expect(meta.model).toBe("deepseek-chat");
    expect(meta.maxTurns).toBe(12);
    expect(meta.tools).toEqual(["read", "grep"]);
    expect(meta.permission).toEqual({ bash: "deny", edit: "ask" });
    expect(body).toBe("# Reviewer body");
  });

  it("discovers builtin agents plus markdown agents from each directory", async () => {
    const p = join(dir, ".maze", "agent");
    await mkdir(p, { recursive: true });
    await writeFile(
      join(p, "auditor.md"),
      "---\ndescription: audits code\nmode: plan\n---\n\nAudit things.\n"
    );
    const agents = await discoverAgents(dir);
    const names = agents.map((a) => a.name);
    expect(names).toEqual(
      expect.arrayContaining(["build", "plan", "explore", "general", "auditor"])
    );
    const auditor = agents.find((a) => a.name === "auditor")!;
    expect(auditor.mode).toBe("plan");
    expect(auditor.readOnly).toBe(true);
    expect(findAgent(agents, "audit")!.name).toBe("auditor");
  });

  it("applies config overrides on top of a builtin agent", async () => {
    const agents = await discoverAgents(dir, {
      agent: { build: { model: "m2", maxTurns: 7 } }
    });
    const build = agents.find((a) => a.name === "build")!;
    expect(build.model).toBe("m2");
    expect(build.maxTurns).toBe(7);
  });

  it("toolsForAgent filters by allowlist and read-only mode", () => {
    const tools = ["read", "grep", "edit", "bash"].map((name) => ({ name }));
    const readOnly = toolsForAgent(
      {
        name: "p",
        description: "",
        mode: "plan",
        prompt: "",
        tools: ["read", "edit"],
        readOnly: true,
        source: "x"
      },
      tools
    );
    expect(readOnly.map((t) => t.name)).toEqual(["read"]);

    const allowlisted = toolsForAgent(
      {
        name: "s",
        description: "",
        mode: "subagent",
        prompt: "",
        tools: ["grep", "bash"],
        source: "x"
      },
      tools
    );
    expect(allowlisted.map((t) => t.name)).toEqual(["grep", "bash"]);
  });

  it("resolveSkillMentions expands @skill and leaves unknown mentions intact", async () => {
    await mkdir(join(dir, "skills", "topic"), { recursive: true });
    await writeFile(
      join(dir, "skills", "topic", "SKILL.md"),
      "---\nname: topic\n---\n\nUse the topic rules.\n"
    );
    const skills = await discoverSkills(dir);
    const out = resolveSkillMentions("apply @topic and @missing", skills);
    expect(out).toContain("Use the topic rules.");
    expect(out).toContain("@missing");
  });
});

describe("prompts", () => {
  it("renders an environment block with mode-specific guidance", () => {
    const chat = environmentBlock({
      cwd: "/work",
      mode: "chat",
      gitRepo: true,
      gitBranch: "main",
      model: "m",
      date: "2026-01-02"
    });
    expect(chat).toContain("- Working directory: /work");
    expect(chat).toContain("chat (user's real working directory)");
    expect(chat).toContain("- Git repository: yes (branch main)");
    expect(chat).toContain("- Date: 2026-01-02");
    expect(chat).toContain("do not run destructive");

    const sub = environmentBlock({ cwd: "/w", mode: "subagent", gitRepo: false });
    expect(sub).toContain("- Git repository: no");
    expect(sub).not.toContain("destructive");
  });

  it("adds reasoning guidance only for reasoning models", () => {
    expect(modelPromptSection(undefined)).toBe("");
    expect(modelPromptSection("deepseek-chat")).toBe("");
    expect(modelPromptSection("deepseek-reasoner")).toContain("# Reasoning model guidance");
  });

  it("assembles environment, memory, goal and extra sections", async () => {
    const goal: Parameters<typeof goalSection>[0] = {
      id: "abcd1234",
      title: "Ship it",
      detail: "with tests",
      status: "active",
      createdAt: "now",
      updatedAt: "now"
    };
    const prompt = await buildSystemPrompt({
      memory: "# Memory\nremember this",
      goal,
      extra: "extra rules",
      environment: "# Environment\n- cwd: /x",
      model: "deepseek-reasoner"
    });
    expect(prompt).toContain("# Environment");
    expect(prompt).toContain("# Project memory");
    expect(prompt).toContain("remember this");
    expect(prompt).toContain("## Active goal (abcd1234)");
    expect(prompt).toContain("**Ship it**");
    expect(prompt).toContain("# Reasoning model guidance");
    expect(prompt).toContain("# Additional instructions");
    expect(prompt).toContain("extra rules");
  });

  it("skips empty optional sections", async () => {
    const prompt = await buildSystemPrompt({ memory: "   ", extra: "  " });
    expect(prompt).not.toContain("# Project memory");
    expect(prompt).not.toContain("# Additional instructions");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("finds the checked-in prompt directory", () => {
    expect(promptDirPath()).not.toBeNull();
  });

  it("goalSection renders an active goal and nothing for null", () => {
    expect(goalSection(null)).toBe("");
    const section = goalSection({
      id: "1",
      title: "T",
      detail: "",
      status: "active",
      createdAt: "a",
      updatedAt: "b"
    });
    expect(section).toContain("## Active goal (1)");
    expect(section).toContain("GOAL COMPLETE");
  });

  it("persists goals through the file store", async () => {
    const store = new FileGoalStore(dir);
    await store.load();
    store.add("persisted", "detail", "s1");
    await store.save();
    const reloaded = new FileGoalStore(dir);
    await reloaded.load();
    expect(reloaded.goals).toHaveLength(1);
    expect(reloaded.goals[0]!.title).toBe("persisted");
    expect(reloaded.active("s1")!.detail).toBe("detail");
    expect(reloaded.find("persisted")).toBeNull();
    expect(reloaded.update(reloaded.goals[0]!.id, { status: "done" })!.status).toBe("done");
    expect(reloaded.update("nope", { status: "done" })).toBeNull();
  });

  it("tolerates a corrupt goals file", async () => {
    await writeFile(join(dir, "goals.json"), "{ not json");
    const store = new FileGoalStore(dir);
    await store.load();
    expect(store.goals).toEqual([]);
  });
});

describe("mcp config", () => {
  it("reads .dream/mcp.json servers and skips disabled or nameless ones", async () => {
    await mkdir(join(dir, ".dream"), { recursive: true });
    await writeFile(
      join(dir, ".dream", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "server"] },
          off: { command: "x", enabled: false },
          _meta: { command: "y" },
          bad: { args: [] }
        }
      })
    );
    const servers = await loadMcpConfig(dir);
    expect(servers).toEqual([
      { name: "fs", command: "npx", args: ["-y", "server"], env: undefined }
    ]);
  });

  it("falls back to the project config's mcp map, accepting argv arrays", async () => {
    await writeFile(
      join(dir, "maze.json"),
      JSON.stringify({
        mcp: {
          fs: { command: ["npx", "-y", "server"] },
          str: { command: "plain", args: ["a"] },
          remote: { type: "remote", url: "https://x" }
        }
      })
    );
    const servers = await loadProjectMcpConfig(dir);
    expect(servers).toEqual([
      { name: "fs", command: "npx", args: ["-y", "server"], env: undefined },
      { name: "str", command: "plain", args: ["a"], env: undefined }
    ]);
  });

  it("returns [] for a malformed config", async () => {
    await writeFile(join(dir, "maze.json"), "{oops");
    expect(await loadProjectMcpConfig(dir)).toEqual([]);
  });

  it("summarises connections and errors", () => {
    expect(mcpSummary({ clients: [], tools: [], errors: [] })).toEqual([
      "no MCP servers configured (.dream/mcp.json)"
    ]);
    const lines = mcpSummary({
      clients: [],
      tools: [],
      errors: [{ server: "fs", message: "spawn failed" }]
    });
    expect(lines[0]).toBe("✗ fs: spawn failed");
  });
});

describe("agent toolset", () => {
  it("registers network, delegate and discovered tools, and closes cleanly", async () => {
    const toolset = await buildAgentToolset({
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: "http://127.0.0.1:1/v1/chat/completions",
      apiKey: "",
      enableMcp: false
    });
    const names = toolset.registry.list().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read", "edit", "bash", "delegate"]));
    expect(toolset.warnings).toEqual([]);
    expect(toolset.close()).toBeUndefined();
  });

  it("skips delegate when disabled", async () => {
    const toolset = await buildAgentToolset({
      workspaceDir: dir,
      model: "m",
      baseUrl: "http://x",
      apiKey: "",
      enableMcp: false,
      enableDelegate: false
    });
    expect(toolset.registry.get("delegate")).toBeUndefined();
    toolset.close();
  });

  it("renders skill and agent prompt sections", () => {
    expect(skillsPrompt([])).toBe("");
    expect(skillsPrompt([{ name: "s", description: "d", body: "b", path: "/p" }])).toContain(
      "- s: d"
    );
    expect(agentsPrompt([])).toBe("");
  });
});

describe("mcp client", () => {
  // A tiny JSON-RPC server over stdio, the same shape as a real MCP server, so
  // the client's handshake, tool listing, call and shutdown are exercised for real.
  const SERVER = `
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id === undefined) continue;
        if (msg.method === "initialize") {
          respond(msg.id, { protocolVersion: "2024-11-05", serverInfo: { name: "fake" } });
        } else if (msg.method === "tools/list") {
          respond(msg.id, {
            tools: [
              { name: "echo", description: "echo back", inputSchema: { type: "object", properties: {} } },
              { name: "fail", description: "always fails", inputSchema: { type: "object" } }
            ]
          });
        } else if (msg.method === "tools/call") {
          if (msg.params.name === "fail") {
            respond(msg.id, { isError: true, content: [{ type: "text", text: "nope" }] });
          } else {
            respond(msg.id, { content: [{ type: "text", text: "echo:" + msg.params.arguments.value }] });
          }
        } else {
          respondError(msg.id, -32601, "method not found");
        }
      }
    });
    function respond(id, result) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
    }
    function respondError(id, code, message) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n");
    }
  `;

  it("handshakes, lists tools, calls them and reports errors", async () => {
    const { McpClient } = await import("../src/mcp.js");
    const client = await McpClient.connect({
      name: "fake",
      command: process.execPath,
      args: ["-e", SERVER]
    });
    try {
      expect(client.isClosed).toBe(false);
      expect(client.toolInfos.map((t) => t.name)).toEqual(["echo", "fail"]);

      const ok = await client.callTool("echo", { value: 42 });
      expect(ok).toEqual({ ok: true, text: "echo:42" });

      const bad = await client.callTool("fail", {});
      expect(bad).toEqual({ ok: false, text: "nope" });
    } finally {
      client.close();
    }
    expect(client.isClosed).toBe(true);
  }, 20000);

  it("surfaces a JSON-RPC error and a closed server", async () => {
    const { McpClient } = await import("../src/mcp.js");
    const client = await McpClient.connect({
      name: "fake2",
      command: process.execPath,
      args: ["-e", SERVER]
    });
    await expect(client.request("nope/method", {})).rejects.toThrow(/method not found/);
    client.close();
    await expect(client.request("tools/list", {})).rejects.toThrow(/closed/);
  }, 20000);

  it("connectMcpServers records a spawn failure as an error", async () => {
    const { connectMcpServers } = await import("../src/mcp.js");
    const result = await connectMcpServers(
      [{ name: "missing", command: "definitely-not-a-real-binary-xyz" }],
      { timeoutMs: 5000 }
    );
    expect(result.clients).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.server).toBe("missing");
  }, 20000);

  it("exposes MCP tools through the registry with a sanitised name", async () => {
    const { connectMcpServers } = await import("../src/mcp.js");
    const result = await connectMcpServers(
      [{ name: "srv-1", command: process.execPath, args: ["-e", SERVER] }],
      { timeoutMs: 10000 }
    );
    try {
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("mcp__srv_1__echo");
      const echo = result.tools.find((t) => t.name === "mcp__srv_1__echo")!;
      const out = await echo.execute(
        { value: "hi" },
        {
          workspaceDir: dir,
          readFiles: new Set(),
          modifiedFiles: new Set(),
          maxOutputBytes: 4096,
          permission: { defaultAction: "allow", rules: [] },
          hooks: { register: () => undefined, list: () => [], runAll: async () => [] }
        }
      );
      expect(out.ok).toBe(true);
      expect(out.content).toBe("echo:hi");
    } finally {
      for (const c of result.clients) c.close();
    }
  }, 20000);
});

describe("chat session build", () => {
  it("builds a session with the expected tools, hooks and cost tracker", async () => {
    const { buildSession, sessionsDir } = await import("../src/chat.js");
    const built = await buildSession({
      model: "deepseek-chat",
      baseUrl: "http://127.0.0.1:1/v1/chat/completions",
      apiKey: "",
      contextWindow: 8000,
      runsDir: join(dir, "chat-runs"),
      verifyCommands: ["true"],
      permission: "allow"
    });
    try {
      expect(existsSync(built.session.path)).toBe(true);
      expect(built.session.path.startsWith(sessionsDir(join(dir, "chat-runs")))).toBe(true);
      expect(built.provider.model).toBe("deepseek-chat");
      expect(built.cost.summary().calls).toBe(0);
      expect(built.hooks.list().map((h) => h.name)).toEqual(["verify-1"]);
      expect(built.tools.list().map((t) => t.name)).toEqual(
        expect.arrayContaining(["read", "edit", "bash"])
      );
      expect(built.executor.readFiles.size).toBe(0);
    } finally {
      built.toolset.close();
    }
  }, 20000);

  it("deny mode fails closed without an approval handler", async () => {
    const { buildSession } = await import("../src/chat.js");
    const built = await buildSession({
      model: "m",
      baseUrl: "http://127.0.0.1:1/v1/chat/completions",
      apiKey: "",
      runsDir: join(dir, "chat-runs2"),
      verifyCommands: [],
      permission: "deny"
    });
    try {
      const decision = await built.executor.context().permission.ask?.({
        tool: "bash",
        pattern: "ls",
        args: { command: "ls" }
      });
      expect(decision).toBeDefined();
      expect(built.executor.context().permission.defaultAction).toBe("deny");
    } finally {
      built.toolset.close();
    }
  }, 20000);
});

describe("session directories", () => {
  it("honours an explicit dir, then MAZE_SESSIONS_DIR, then XDG", () => {
    expect(sessionsDir("/tmp/explicit")).toBe("/tmp/explicit");
    const prev = process.env.MAZE_SESSIONS_DIR;
    const prevXdg = process.env.XDG_DATA_HOME;
    try {
      process.env.MAZE_SESSIONS_DIR = "/tmp/from-env";
      expect(sessionsDir()).toBe("/tmp/from-env");
      delete process.env.MAZE_SESSIONS_DIR;
      process.env.XDG_DATA_HOME = "/tmp/xdg";
      expect(sessionsDir()).toBe(join("/tmp/xdg", "maze", "sessions"));
    } finally {
      if (prev === undefined) delete process.env.MAZE_SESSIONS_DIR;
      else process.env.MAZE_SESSIONS_DIR = prev;
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
    }
  });
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

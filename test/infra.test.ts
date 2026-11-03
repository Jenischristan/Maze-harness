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
    expect(names).toEqual(expect.arrayContaining(["build", "plan", "explore", "general", "auditor"]));
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
      { name: "p", description: "", mode: "plan", prompt: "", tools: ["read", "edit"], readOnly: true, source: "x" },
      tools
    );
    expect(readOnly.map((t) => t.name)).toEqual(["read"]);

    const allowlisted = toolsForAgent(
      { name: "s", description: "", mode: "subagent", prompt: "", tools: ["grep", "bash"], source: "x" },
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

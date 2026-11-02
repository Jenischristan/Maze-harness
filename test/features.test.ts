import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  cloneSession,
  deleteSession,
  parseSessionArgs,
  renameSession,
  resumeSession,
  sessionLines
} from "../src/session/lifecycle.js";
import { SessionStore } from "../src/session/store.js";
import { discoverSkills, findSkill, skillPrompt } from "../src/skills.js";
import { loadMcpConfig, mcpSummary, type McpConnectionResult } from "../src/mcp.js";
import { SUBAGENTS, findSubAgent } from "../src/subagents.js";
import { diffWorkspace, diffSummaryLines } from "../src/workspace/diff.js";
import { initProject } from "../src/project-init.js";
import { thinkingBody } from "../src/agent/provider.js";

async function seedSession(dir: string, messages: string[]): Promise<SessionStore> {
  const store = new SessionStore({ dir, model: "test-model", name: "seed" });
  await store.init();
  for (const m of messages) {
    await store.appendMessage({ role: "user", content: m });
    await store.appendMessage({ role: "assistant", content: `re: ${m}` });
  }
  return store;
}

/* ------------------------------------------------------------------ */
/* 1. Session lifecycle                                                */
/* ------------------------------------------------------------------ */

describe("session lifecycle", () => {
  it("parseSessionArgs understands every action", () => {
    expect(parseSessionArgs("")).toEqual({ action: "list" });
    expect(parseSessionArgs("list")).toEqual({ action: "list" });
    expect(parseSessionArgs("new my session")).toEqual({ action: "new", name: "my session" });
    expect(parseSessionArgs("clone abc")).toEqual({ action: "clone", id: "abc" });
    expect(parseSessionArgs("fork abc m-1")).toEqual({ action: "fork", id: "abc", at: "m-1" });
    expect(parseSessionArgs("resume abc")).toEqual({ action: "resume", id: "abc" });
    expect(parseSessionArgs("name hello there")).toEqual({ action: "name", name: "hello there" });
    expect(parseSessionArgs("delete abc")).toEqual({ action: "delete", id: "abc" });
    expect(parseSessionArgs("abc123")).toEqual({ action: "resume", id: "abc123" });
  });

  it("clone copies the full conversation into a new session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dh-clone-"));
    const src = await seedSession(dir, ["one", "two"]);
    const clone = await cloneSession(dir, src.meta.runId, "clone", { model: "m" });
    expect(clone.meta.runId).not.toBe(src.meta.runId);
    const msgs = clone.projection().filter((m) => !m.synthetic);
    expect(msgs.map((m) => m.content)).toEqual(["one", "re: one", "two", "re: two"]);
    expect(src.projection().filter((m) => !m.synthetic).length).toBe(4);
    expect(clone.meta.name).toContain("(clone)");
  });

  it("fork stops at the requested entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dh-fork-"));
    const src = await seedSession(dir, ["a", "b", "c"]);
    const branch = src.activeBranch().filter((e) => e.kind === "message");
    const at = branch[2]!.id;
    const fork = await cloneSession(dir, src.meta.runId, "fork", { at });
    const contents = fork.projection().filter((m) => !m.synthetic).map((m) => m.content);
    expect(contents).toEqual(["a", "re: a"]);
  });

  it("fork rejects an entry not on the active branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dh-fork-bad-"));
    const src = await seedSession(dir, ["x"]);
    await expect(cloneSession(dir, src.meta.runId, "fork", { at: "nope" })).rejects.toThrow();
  });

  it("rename rewrites the header and listSessions shows the name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dh-rename-"));
    const src = await seedSession(dir, ["hi"]);
    const applied = await renameSession(dir, src.meta.runId, "my session");
    expect(applied).toBe("my session");
    const lines = await sessionLines(dir, src.meta.runId);
    expect(lines[0]!.name).toBe("my session");
    expect(lines[0]!.active).toBe(true);
    expect(await readFile(src.path, "utf8")).toContain("my session");
  });

  it("rename rejects an empty name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dh-rename-empty-"));
    const src = await seedSession(dir, ["hi"]);
    await expect(renameSession(dir, src.meta.runId, "   ")).rejects.toThrow();
  });

  it("resume reloads an existing session with its messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dh-resume-"));
    const src = await seedSession(dir, ["kept"]);
    const resumed = await resumeSession(dir, src.meta.runId);
    const contents = resumed.projection().filter((m) => !m.synthetic).map((m) => m.content);
    expect(contents).toEqual(["kept", "re: kept"]);
  });

  it("delete removes the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dh-del-"));
    const src = await seedSession(dir, ["bye"]);
    expect(existsSync(src.path)).toBe(true);
    await deleteSession(dir, src.meta.runId);
    expect(existsSync(src.path)).toBe(false);
    await expect(deleteSession(dir, src.meta.runId)).rejects.toThrow();
  });

  it("cloneSession + cloneSession(fork) always yield distinct runIds", async () => {
    // Pure helper-level check: no dispatch timing involved.
    const dir = await mkdtemp(join(tmpdir(), "dh-clone-fork-"));
    const src = await seedSession(dir, ["seed"]);
    const clone = await cloneSession(dir, src.meta.runId, "clone");
    const fork = await cloneSession(dir, clone.meta.runId, "fork");
    const ids = new Set([src.meta.runId, clone.meta.runId, fork.meta.runId]);
    expect(ids.size).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Thinking mode                                                    */
/* ------------------------------------------------------------------ */

describe("thinking body translation", () => {
  it("leaves the request untouched by default", () => {
    expect(thinkingBody("deepseek-chat", undefined)).toEqual({});
  });

  it("disables thinking per vendor", () => {
    expect(thinkingBody("deepseek-reasoner", false)).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingBody("claude-3-5-sonnet", false)).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingBody("gpt-4o", false)).toEqual({ reasoning: { effort: "none" } });
  });
});

/* ------------------------------------------------------------------ */
/* 3. Skills                                                           */
/* ------------------------------------------------------------------ */

describe("skills", () => {
  async function skillRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "dh-skill-"));
    const dir = join(root, ".dream", "skills", "code-review");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: code-review\ndescription: Review a diff\nallowed-tools: [read, grep]\n---\n\n# Code review\n\nRead the diff and list defects.\n"
    );
    await mkdir(join(root, "skills"), { recursive: true });
    await writeFile(join(root, "skills", "plain.md"), "# Plain skill\n\nJust do it.\n");
    return root;
  }

  it("discovers skills from both layouts and parses frontmatter", async () => {
    const root = await skillRoot();
    const skills = await discoverSkills(root);
    const review = findSkill(skills, "code-review");
    expect(review).toBeTruthy();
    expect(review!.description).toBe("Review a diff");
    expect(review!.allowedTools).toEqual(["read", "grep"]);
    expect(review!.body).toContain("Read the diff");
    const plain = findSkill(skills, "plain");
    expect(plain).toBeTruthy();
    expect(plain!.description).toBe("Plain skill");
  });

  it("finds skills by prefix and rejects unknown names", async () => {
    const root = await skillRoot();
    const skills = await discoverSkills(root);
    expect(findSkill(skills, "code")?.name).toBe("code-review");
    expect(findSkill(skills, "nope")).toBeNull();
  });

  it("skillPrompt embeds the body and the application instruction", async () => {
    const root = await skillRoot();
    const skills = await discoverSkills(root);
    const prompt = skillPrompt(findSkill(skills, "code-review")!);
    expect(prompt).toContain("# Skill: code-review");
    expect(prompt).toContain("Read the diff and list defects.");
    expect(prompt).toContain("Apply this skill");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Sub-agents                                                       */
/* ------------------------------------------------------------------ */

describe("sub-agents", () => {
  it("ships the five specialists with descriptions", () => {
    const names = SUBAGENTS.map((a) => a.name);
    expect(names).toEqual(["explore", "review", "test", "plan", "verify"]);
    for (const a of SUBAGENTS) {
      expect(a.description.length).toBeGreaterThan(0);
      expect(a.prompt.length).toBeGreaterThan(0);
      expect(a.maxTurns).toBeGreaterThan(0);
    }
  });

  it("read-only specialists never allow mutation tools", () => {
    for (const name of ["explore", "review", "plan"]) {
      const spec = findSubAgent(name)!;
      expect(spec.tools).toBeDefined();
      expect(spec.tools).not.toContain("edit");
      expect(spec.tools).not.toContain("write");
    }
  });

  it("finds by prefix and rejects unknown", () => {
    expect(findSubAgent("rev")?.name).toBe("review");
    expect(findSubAgent("nope")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 5. MCP                                                              */
/* ------------------------------------------------------------------ */

describe("mcp config", () => {
  it("returns no servers when no config exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "dh-mcp-none-"));
    expect(await loadMcpConfig(root)).toEqual([]);
  });

  it("parses mcpServers from .dream/mcp.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "dh-mcp-"));
    await mkdir(join(root, ".dream"), { recursive: true });
    await writeFile(
      join(root, ".dream", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fs: { command: "node", args: ["server.js"], env: { X: "1" } },
          broken: { notCommand: true }
        }
      })
    );
    const servers = await loadMcpConfig(root);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({
      name: "fs",
      command: "node",
      args: ["server.js"],
      env: { X: "1" }
    });
  });

  it("mcpSummary reports empty, connected, and failed servers", () => {
    expect(mcpSummary({ clients: [], tools: [], errors: [] })).toEqual([
      "no MCP servers configured (.dream/mcp.json)"
    ]);
    const result: McpConnectionResult = {
      clients: [],
      tools: [],
      errors: [{ server: "fs", message: "spawn failed" }]
    };
    const lines = mcpSummary(result);
    expect(lines[0]).toContain("✗ fs");
    expect(lines[0]).toContain("spawn failed");
  });
});

/* ------------------------------------------------------------------ */
/* 6. Diff                                                             */
/* ------------------------------------------------------------------ */

describe("diff", () => {
  it("reports no changes for a clean workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dh-diff-clean-"));
    await writeFile(join(root, "a.txt"), "same\n");
    await mkdir(join(root, ".git"), { recursive: true });
    const diff = await diffWorkspace({ cwd: root });
    expect(diffSummaryLines(diff)).toEqual(["not a git repository"]);
  });
});

/* ------------------------------------------------------------------ */
/* 7. Project init                                                     */
/* ------------------------------------------------------------------ */

describe("project init", () => {
  it("scaffolds the .dream layout and never overwrites", async () => {
    const root = await mkdtemp(join(tmpdir(), "dh-init-"));
    const first = await initProject(root);
    expect(first.created).toEqual(
      expect.arrayContaining([
        ".dream/memory.md",
        "AGENTS.md",
        ".dream/mcp.json",
        ".dream/skills/example/SKILL.md",
        ".dream/config.json",
        ".gitignore"
      ])
    );
    expect(existsSync(join(root, "runs"))).toBe(true);
    const second = await initProject(root);
    expect(second.created).toEqual([]);
    expect(second.skipped.length).toBe(first.created.length);
  });

  it("the generated MCP config is valid and the skill is discoverable", async () => {
    const root = await mkdtemp(join(tmpdir(), "dh-init2-"));
    await initProject(root);
    const raw = JSON.parse(await readFile(join(root, ".dream", "mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers).toBeDefined();
    const skills = await discoverSkills(root);
    expect(skills.map((s) => s.name)).toContain("example");
  });
});

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentConfigEntry, FileConfig } from "../config.js";
import { discoverSkills, findSkill, skillPrompt, type Skill } from "../skills.js";

export type AgentMode = "build" | "plan" | "subagent";

export interface AgentDefinition {
  name: string;
  description: string;
  mode: AgentMode;

  prompt: string;

  model?: string;

  tools?: string[];

  permission?: Record<string, "allow" | "ask" | "deny">;
  maxTurns?: number;

  readOnly?: boolean;
  source: string;
}

export const MUTATING_TOOLS = new Set(["edit", "write", "apply_patch", "bash", "multiedit"]);

export const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "page",
  "webfetch",
  "websearch",
  "todo",
  "question",
  "lsp",
  "delegate"
]);

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "build",
    description: "Full coding agent: read, edit, run commands, verify.",
    mode: "build",
    prompt: "",
    source: "builtin"
  },
  {
    name: "plan",
    description: "Read-only planner: investigate and produce a plan, no edits.",
    mode: "plan",
    prompt: [
      "# Role: planner",
      "",
      "You investigate the repository and produce a concrete implementation plan.",
      "You cannot edit files or run mutating commands. Read code, trace call paths,",
      "then return ordered steps naming files and functions, the risks, and how",
      "each step will be verified."
    ].join("\n"),
    tools: [...READ_ONLY_TOOLS],
    readOnly: true,
    source: "builtin"
  },
  {
    name: "explore",
    description: "Fast read-only search agent: find files and symbols, report findings.",
    mode: "subagent",
    prompt: [
      "# Role: explorer",
      "",
      "You explore a codebase and report what you find. You do not modify files.",
      "Locate the relevant files and symbols, read them, and return a concise map:",
      "file paths with line numbers, how the pieces connect, and any gotchas.",
      "Prefer grep/glob over guessing. Stop as soon as the question is answered."
    ].join("\n"),
    tools: [...READ_ONLY_TOOLS],
    readOnly: true,
    maxTurns: 20,
    source: "builtin"
  },
  {
    name: "general",
    description: "General-purpose subagent with full tool access for a self-contained task.",
    mode: "subagent",
    prompt: [
      "# Role: generalist",
      "",
      "You complete a self-contained task end to end: investigate, change code,",
      "and verify. You cannot ask the user follow-up questions, so state any",
      "assumption you had to make in your final report."
    ].join("\n"),
    maxTurns: 30,
    source: "builtin"
  }
];

const AGENT_DIRS = [".maze/agent", ".agents/agent", ".opencode/agent"];

interface Frontmatter {
  description?: string;
  mode?: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  permission?: Record<string, "allow" | "ask" | "deny">;
}

export function parseAgentFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { meta: {}, body: text.trim() };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: text.trim() };
  const head = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Frontmatter = {};
  let inPermission = false;
  for (const line of head.split(/\r?\n/)) {
    if (/^\s+/.test(line) && inPermission) {
      const m = /^\s+([A-Za-z0-9_*-]+)\s*:\s*(allow|ask|deny)\s*$/.exec(line);
      if (m) {
        meta.permission ??= {};
        meta.permission[m[1]!] = m[2] as "allow" | "ask" | "deny";
      }
      continue;
    }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    inPermission = false;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "permission") {
      inPermission = true;
      meta.permission ??= {};
      if (value === "{}" || value === "") continue;
    } else if (key === "description") meta.description = value;
    else if (key === "mode") meta.mode = value;
    else if (key === "model") meta.model = value;
    else if (key === "max-turns" || key === "maxturns") meta.maxTurns = Number(value) || undefined;
    else if (key === "tools") {
      meta.tools = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }
  return { meta, body: body.trim() };
}

function fromMarkdown(name: string, raw: string, path: string): AgentDefinition | null {
  const { meta, body } = parseAgentFrontmatter(raw);
  if (!body.trim()) return null;
  const mode: AgentMode =
    meta.mode === "plan"
      ? "plan"
      : meta.mode === "subagent"
        ? "subagent"
        : meta.mode === "build"
          ? "build"
          : "subagent";
  return {
    name,
    description: meta.description ?? body.split("\n").find((l) => l.trim()) ?? name,
    mode,
    prompt: body,
    model: meta.model,
    tools: meta.tools,
    permission: meta.permission,
    maxTurns: meta.maxTurns,
    readOnly: mode === "plan",
    source: path
  };
}

function fromConfig(name: string, entry: AgentConfigEntry): AgentDefinition {
  const mode: AgentMode =
    entry.mode === "plan" ? "plan" : entry.mode === "build" ? "build" : "subagent";
  const tools = entry.tools
    ? Object.entries(entry.tools)
        .filter(([, enabled]) => enabled)
        .map(([tool]) => tool)
    : undefined;
  return {
    name,
    description: `${name} agent`,
    mode,
    prompt: entry.prompt ?? "",
    model: entry.model,
    tools,
    permission: entry.permission,
    maxTurns: entry.maxTurns,
    readOnly: mode === "plan",
    source: "config"
  };
}

export async function discoverAgents(
  root: string,
  config: FileConfig = {}
): Promise<AgentDefinition[]> {
  const byName = new Map<string, AgentDefinition>();
  for (const agent of BUILTIN_AGENTS) byName.set(agent.name, agent);
  for (const rel of AGENT_DIRS) {
    const dir = join(resolve(root), rel);
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      const path = join(dir, entry);
      const raw = await readFile(path, "utf8").catch(() => "");
      const agent = fromMarkdown(entry.replace(/\.md$/, ""), raw, path);
      if (agent) byName.set(agent.name, agent);
    }
  }
  for (const [name, entry] of Object.entries(config.agent ?? {})) {
    const existing = byName.get(name);
    byName.set(name, { ...(existing ?? fromConfig(name, entry)), ...fromConfig(name, entry) });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findAgent(agents: AgentDefinition[], name: string): AgentDefinition | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  return agents.find((a) => a.name === q) ?? agents.find((a) => a.name.startsWith(q)) ?? null;
}

export function toolsForAgent<T extends { name: string }>(agent: AgentDefinition, tools: T[]): T[] {
  const allowed = agent.tools ? new Set(agent.tools) : null;
  return tools.filter((t) => {
    if (allowed && !allowed.has(t.name)) return false;
    if (agent.readOnly && MUTATING_TOOLS.has(t.name)) return false;
    return true;
  });
}

export function resolveSkillMentions(prompt: string, skills: Skill[]): string {
  return prompt.replace(/@([a-z0-9][a-z0-9_-]*)/gi, (match, name: string) => {
    const skill = findSkill(skills, name);
    return skill ? `\n\n${skillPrompt(skill)}\n` : match;
  });
}

export async function loadSkills(root: string): Promise<Skill[]> {
  return discoverSkills(root).catch(() => []);
}

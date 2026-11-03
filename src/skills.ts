import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface Skill {
  name: string;
  description: string;

  body: string;

  path: string;

  allowedTools?: string[];
}

const SKILL_DIRS = [".dream/skills", ".claude/skills", ".agents/skills", "skills"];

interface Frontmatter {
  name?: string;
  description?: string;
  allowedTools?: string[];
}

function parseFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { meta: {}, body: text.trim() };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: text.trim() };
  const head = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const meta: Frontmatter = {};
  for (const line of head.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    let value = m[2]!.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1);
      meta.allowedTools = value
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }
    // Strip matching single or double quotes from scalar values; leaving them
    // on made `description: 'x'` render the quotes in the skills prompt.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name") meta.name = value;
    else if (key === "description") meta.description = value;
    else if (key === "allowed-tools" || key === "allowedtools") {
      meta.allowedTools = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return { meta, body: body.trim() };
}

function loadFrom(raw: string, path: string): Skill | null {
  const { meta, body } = parseFrontmatter(raw);
  if (!body.trim()) return null;

  const base = path.split(/[\\/]/).pop() ?? "skill";
  const fallback =
    /^skill\.md$/i.test(base) || !/\.md$/i.test(base)
      ? (dirname(path).split(/[\\/]/).pop() ?? "skill")
      : base.replace(/\.md$/i, "");
  return {
    name: meta.name ?? fallback,
    description: meta.description ?? firstLine(body),
    body,
    path,
    allowedTools: meta.allowedTools
  };
}

function firstLine(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t.slice(0, 120);
  }
  return "skill";
}

export async function discoverSkills(root: string): Promise<Skill[]> {
  const seen = new Map<string, Skill>();
  for (const rel of SKILL_DIRS) {
    const dir = join(resolve(root), rel);
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const candidates = entry.toLowerCase().endsWith(".md")
        ? [join(dir, entry)]
        : [join(dir, entry, "SKILL.md"), join(dir, entry, "skill.md"), join(dir, `${entry}.md`)];
      let loaded = false;
      for (const path of candidates) {
        if (loaded) break;
        if (!existsSync(path)) continue;
        const raw = await readFile(path, "utf8").catch(() => "");
        const skill = loadFrom(raw, path);
        if (!skill) continue;

        if (!seen.has(skill.name)) seen.set(skill.name, skill);
        loaded = true;
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(skills: Skill[], query: string): Skill | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return (
    skills.find((s) => s.name.toLowerCase() === q) ??
    skills.find((s) => s.name.toLowerCase().startsWith(q)) ??
    null
  );
}

export function skillPrompt(skill: Skill): string {
  return [
    `# Skill: ${skill.name}`,
    "",
    skill.body,
    "",
    "Apply this skill to the task below. Follow its steps and conventions exactly."
  ].join("\n");
}

export function skillLines(skills: Skill[], width: number): string[] {
  if (skills.length === 0) {
    return ["  no skills found (create .dream/skills/<name>/SKILL.md)"];
  }
  return skills.map((s) => {
    const usage = `/skill ${s.name}`.padEnd(Math.min(24, Math.max(12, width - 30)));
    return `  ${usage} ${s.description}`;
  });
}

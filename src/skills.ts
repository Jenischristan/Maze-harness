import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface Skill {
  name: string;
  description: string;
  /** Markdown body injected into the system prompt / user message. */
  body: string;
  /** Absolute path to the SKILL.md, for reference. */
  path: string;
  /** Optional tool allowlist parsed from frontmatter `allowed-tools`. */
  allowedTools?: string[];
}

const SKILL_DIRS = [".dream/skills", ".claude/skills", ".agents/skills", "skills"];

interface Frontmatter {
  name?: string;
  description?: string;
  allowedTools?: string[];
}

/**
 * Minimal YAML-ish frontmatter parser. We intentionally avoid a YAML
 * dependency: skills use a tiny, flat subset (`key: value` and inline
 * `[a, b]` lists), which is all the format needs.
 */
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
    if (
      (value.startsWith("[") && value.endsWith("]")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      if (value.startsWith("[")) {
        value = value.slice(1, -1);
        meta.allowedTools = value
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        continue;
      }
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
  // Directory layout (`<name>/SKILL.md`) takes the name from the directory;
  // loose-file layout (`<name>.md`) must take it from the file stem, since
  // dirname() would yield the parent directory ("skills").
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

/** Discover skills under the workspace, first directory wins per name. */
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
      // Two layouts are accepted:
      //   <dir>/<name>/SKILL.md   (directory form)
      //   <dir>/<name>.md         (loose file form)
      // `entry` is the raw directory entry, so a file already ends in `.md` and
      // must NOT get another suffix (that produced `<name>.md.md`).
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
        // A `<name>/SKILL.md` wins over a sibling `<name>.md` for the same
        // entry; only fall through to the loose file when the directory had no
        // loadable skill.
        if (!seen.has(skill.name)) seen.set(skill.name, skill);
        loaded = true;
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a skill by exact name or unique prefix. */
export function findSkill(skills: Skill[], query: string): Skill | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return (
    skills.find((s) => s.name.toLowerCase() === q) ??
    skills.find((s) => s.name.toLowerCase().startsWith(q)) ??
    null
  );
}

/** Render the skill's body as the instruction block injected into a turn. */
export function skillPrompt(skill: Skill): string {
  return [
    `# Skill: ${skill.name}`,
    "",
    skill.body,
    "",
    "Apply this skill to the task below. Follow its steps and conventions exactly."
  ].join("\n");
}

/** Compact catalogue for the palette / help list. */
export function skillLines(skills: Skill[], width: number): string[] {
  if (skills.length === 0) {
    return ["  no skills found (create .dream/skills/<name>/SKILL.md)"];
  }
  return skills.map((s) => {
    const usage = `/skill ${s.name}`.padEnd(Math.min(24, Math.max(12, width - 30)));
    return `  ${usage} ${s.description}`;
  });
}

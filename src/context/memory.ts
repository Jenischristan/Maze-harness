import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MEMORY_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  ".dream/memory.md",
  "docs/memory.md"
];

function render(root: string, path: string, content: string): string {
  const rel = relative(resolve(root), path).split("\\").join("/");
  return `<!-- ${rel} -->\n${content.trim()}`;
}

export interface MemoryBundle {
  files: Array<{ path: string; content: string }>;
  text: string;
}

async function hierarchicalFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const start = resolve(root);
  const chain: string[] = [];
  let cur = start;
  for (;;) {
    chain.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  chain.reverse();
  const out: Array<{ path: string; content: string }> = [];
  for (const dir of chain) {
    for (const rel of MEMORY_FILES) {
      const path = join(dir, rel);
      if (!existsSync(path)) continue;
      const content = await readFile(path, "utf8").catch(() => "");
      if (content.trim().length > 0) out.push({ path, content: content.trim() });
    }
  }
  return out;
}

async function expandGlob(root: string, pattern: string): Promise<string[]> {
  const base = resolve(root, pattern);
  const prefix = base.slice(0, base.search(/[*?]/));
  const dir = prefix.endsWith("/") ? prefix.slice(0, -1) : dirname(prefix);
  const regex = globToRegExp(relative(resolve(root), base).split("\\").join("/"));
  const matches: string[] = [];
  const { readdir } = await import("node:fs/promises");
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        const rel = relative(resolve(root), full).split("\\").join("/");
        if (regex.test(rel)) matches.push(full);
      }
    }
  }
  return matches.sort();
}

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          re += "(?:.*/)?";
          i += 1;
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("\\^$+.()|{}[]".includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`${re}$`);
}

export async function loadMemory(root: string, extraGlobs: string[] = []): Promise<MemoryBundle> {
  const files = await hierarchicalFiles(root);
  const seen = new Set(files.map((f) => resolve(f.path)));
  for (const pattern of extraGlobs) {
    const abs = isAbsolute(pattern) ? pattern : pattern;
    for (const path of await expandGlob(root, abs)) {
      const key = resolve(path);
      if (seen.has(key)) continue;
      seen.add(key);
      const content = await readFile(path, "utf8").catch(() => "");
      if (content.trim().length > 0) files.push({ path, content: content.trim() });
    }
  }
  const text = files.map((f) => render(root, f.path, f.content)).join("\n\n");
  return { files, text };
}

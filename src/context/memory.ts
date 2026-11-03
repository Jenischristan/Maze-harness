import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const MEMORY_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  ".dream/memory.md",
  "docs/memory.md"
];

const MEMORY_TEMPLATE = `# Project memory

Loaded into every agent session. Keep it short and concrete.

## Build & test commands
- \`pnpm test\` — run the test suite
- \`pnpm typecheck\` — type-check without emitting

## Conventions
- Edits must be exact-match; read a file before editing it.
- Prefer small, focused changes with a test.

## Gotchas
- \`runs/\` and \`worktrees/\` are generated; do not edit them.
`;

export interface MemoryBundle {
  files: Array<{ path: string; content: string }>;
  text: string;
}

/** Load project memory files from `root` (non-recursive, top-level only). */
export async function loadMemory(root: string): Promise<MemoryBundle> {
  const files: Array<{ path: string; content: string }> = [];
  for (const rel of MEMORY_FILES) {
    const path = join(resolve(root), rel);
    if (!existsSync(path)) continue;
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.trim().length > 0) files.push({ path, content: content.trim() });
  }
  const text = files.map((f) => `<!-- ${f.path} -->\n${f.content}`).join("\n\n");
  return { files, text };
}

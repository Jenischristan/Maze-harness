import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_SCORE_CONFIG } from "./score.js";

export interface InitResult {
  created: string[];
  skipped: string[];
  root: string;
}

/**
 * `/init` writes scaffolding only — memory, MCP config, skills, `.gitignore`.
 *
 * It deliberately writes **no** `.dream/config.json`: configuration is flags +
 * environment only (see `src/config.ts`), so a persisted defaults file would be
 * a second source of truth that nothing reads. Earlier versions wrote one and
 * committed it; both are gone.
 */

const MEMORY_TEMPLATE = `# Project memory

Loaded into every agent session. Keep it short and concrete.

## Build & test commands
- \`pnpm test\` — run the test suite
- \`pnpm typecheck\` — type-check without emitting

## Conventions
- Edits must be exact-match; read a file before editing it.
- Prefer small, focused changes with a test.

## Gotchas
- \`runs/\` is generated; do not edit it.
`;

// The template ships with an EMPTY server map on purpose. An earlier template
// declared a `_example` server, which `/init` then wrote to disk; on the next
// start the harness connected it and tried to spawn `npx` (network + an
// external package). A scaffold must never start processes on its own, so the
// commented shape is documented here instead of being a live entry.
const MCP_TEMPLATE = `{
  "mcpServers": {}
}
`;
// JSON has no comments, and appending "#" lines to mcp.json would make it
// unparseable, so the usage note lives in its own markdown file next to it.
const MCP_README = `# MCP servers

Add servers under \`mcpServers\` in \`mcp.json\`, for example:

\`\`\`json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
\`\`\`

Each entry is spawned with the given \`command\`/\`args\`/\`env\` when the harness
starts, and its tools are exposed to the agent as \`mcp__<server>__<tool>\`.
The map is intentionally empty by default: a scaffold must not start processes
on its own.
`;

const SKILL_TEMPLATE = `---
name: example
description: One-line description shown by the skill tool.
allowed-tools: [read, grep, glob, edit, write, bash]
---

# Example skill

Describe when to use this skill and the exact steps to follow. The agent
injects this body into its instructions when the skill is selected.
`;

const GITIGNORE_TEMPLATE = `runs/
worktrees/
node_modules/
dist/
*.log
`;

/**
 * `/init` — create the initial Dream-RSI project scaffolding in `root`
 * without overwriting anything that already exists.
 *
 * Layout mirrors what the harness reads at runtime:
 *   .dream/memory.md     project memory (also seeds AGENTS.md)
 *   .dream/mcp.json      MCP server definitions
 *   .dream/skills/…      skill catalogue
 *
 * There is no `config.json`: runtime configuration comes from flags and
 * environment variables only.
 */
export async function initProject(
  root: string,
  opts: { force?: boolean } = {}
): Promise<InitResult> {
  const base = resolve(root);
  const created: string[] = [];
  const skipped: string[] = [];
  const write = async (rel: string, content: string): Promise<void> => {
    const path = join(base, rel);
    if (existsSync(path) && !opts.force) {
      skipped.push(rel);
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
    created.push(rel);
  };

  await write(".dream/memory.md", MEMORY_TEMPLATE);
  await write("AGENTS.md", MEMORY_TEMPLATE);
  await write(".dream/mcp.json", MCP_TEMPLATE);
  await write(".dream/MCP.md", MCP_README);
  await write(".dream/skills/example/SKILL.md", SKILL_TEMPLATE);
  await write(".gitignore", GITIGNORE_TEMPLATE);
  await mkdir(join(base, "runs"), { recursive: true });
  return { created, skipped, root: base };
}

// Keep the score defaults reachable for callers that build a config from
// scratch; exported so the CLI can mirror the loop's objective exactly.
export { DEFAULT_SCORE_CONFIG };

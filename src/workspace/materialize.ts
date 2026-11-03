import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const COPY_EXCLUDE = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "runs",
  "worktrees",
  "tmp",
  ".maze",
  "examples"
]);

const COPY_FILES = [
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
  "eslint.config.mjs",
  "pnpm-lock.yaml",
  "README.md",
  "LICENSE",
  "AGENTS.md",
  ".prettierrc.json",
  ".prettierignore",
  ".gitignore",
  ".nvmrc",
  ".node-version"
];

export interface MaterializeOptions {
  root: string;
  target: string;
  force?: boolean;
}

async function copyTree(src: string, dest: string): Promise<void> {
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    if (COPY_EXCLUDE.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await cp(from, to, { force: true });
  }
}

export async function materializeWorkspace(opts: MaterializeOptions): Promise<string> {
  const root = resolve(opts.root);
  const target = resolve(opts.target);
  if (existsSync(target) && opts.force !== false) {
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(target, { recursive: true });
  for (const rel of COPY_FILES) {
    const from = join(root, rel);
    if (!existsSync(from)) continue;
    const to = join(target, rel);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { force: true });
  }
  for (const dir of ["src", "test", "prompts", "agents"]) {
    const from = join(root, dir);
    if (!existsSync(from)) continue;
    await copyTree(from, join(target, dir));
  }
  return target;
}

export async function workspaceSourceMatches(root: string, target: string): Promise<boolean> {
  if (!existsSync(join(target, "src", "cli.ts"))) return false;
  if (!existsSync(join(root, "src", "cli.ts"))) return false;
  const { readFile, stat } = await import("node:fs/promises");
  const [a, b] = await Promise.all([
    stat(join(root, "src", "cli.ts")),
    stat(join(target, "src", "cli.ts"))
  ]);
  if (a.size !== b.size) return false;
  const [x, y] = await Promise.all([
    readFile(join(root, "src", "cli.ts")),
    readFile(join(target, "src", "cli.ts"))
  ]);
  return x.equals(y);
}

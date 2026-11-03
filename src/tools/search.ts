import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveInside } from "./paths.js";
import { truncateOutput } from "./truncate.js";

export const lsTool: ToolDefinition = {
  name: "ls",
  description:
    "List a directory relative to the workspace. Shows type (d/f), size, and name, sorted directories first. Hidden entries are included unless `all: false`.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (default workspace root)." },
      all: { type: "boolean", description: "Include hidden entries (default true)." },
      maxEntries: { type: "number", description: "Max entries to list (default 500)." }
    },
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    let dir: string;
    try {
      dir = resolveInside(ctx.workspaceDir, String(args.path ?? "."));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { callId: "", name: "ls", ok: false, content: message, error: "bad-path" };
    }
    const showAll = args.all !== false;
    const maxEntries = Math.min(5000, Math.max(1, Number(args.maxEntries ?? 500) || 500));
    const { readdir } = await import("node:fs/promises");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId: "",
        name: "ls",
        ok: false,
        content: `ls failed: ${message}`,
        error: message
      };
    }
    const rows: Array<{ name: string; dir: boolean; size: number }> = [];
    for (const e of entries) {
      if (!showAll && e.name.startsWith(".")) continue;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = `${dir}/${e.name}`;
      let size = 0;
      if (e.isFile()) size = (await stat(full).catch(() => ({ size: 0 }))).size;
      rows.push({ name: e.name + (e.isDirectory() ? "/" : ""), dir: e.isDirectory(), size });
    }
    rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const lines = rows
      .slice(0, maxEntries)
      .map((r) => `${r.dir ? "d" : "f"} ${String(r.size).padStart(9)} ${r.name}`);
    if (rows.length > maxEntries) lines.push(`… ${rows.length - maxEntries} more entries`);
    const t = truncateOutput(lines.join("\n") || "(empty directory)", ctx.maxOutputBytes);
    return {
      callId: "",
      name: "ls",
      ok: true,
      content: t.text,
      data: { path: dir, count: rows.length }
    };
  }
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  "runs",
  "worktrees",
  ".next",
  "target",
  ".turbo",
  "coverage"
]);

function hasRipgrep(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile("rg", ["--version"], { timeout: 3000 }, (err) => resolvePromise(!err));
  });
}

let ripgrepAvailable: boolean | null = null;

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with a JavaScript-compatible regular expression (ripgrep-backed when available, so .gitignore is respected). Returns file:line:match. Optionally restrict with `glob` and `path`.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regex source." },
      path: {
        type: "string",
        description: "Directory or file to search (default workspace root)."
      },
      glob: { type: "string", description: "Only search files matching this glob." },
      maxResults: { type: "number", description: "Max matching lines (default 200)." },
      caseInsensitive: { type: "boolean", description: "Case-insensitive search." }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "");
    if (!pattern) {
      return {
        callId: "",
        name: "grep",
        ok: false,
        content: "empty pattern",
        error: "empty-pattern"
      };
    }
    const base = String(args.path ?? ".");
    const maxResults = Math.min(5000, Math.max(1, Number(args.maxResults ?? 200) || 200));
    try {
      const root = resolveInside(ctx.workspaceDir, base);
      if (ripgrepAvailable === null) ripgrepAvailable = await hasRipgrep();
      const lines = ripgrepAvailable
        ? await ripgrep(pattern, root, ctx.workspaceDir, args, maxResults, ctx.signal)
        : await nodeGrep(pattern, root, ctx.workspaceDir, args, maxResults);
      const t = truncateOutput(lines.join("\n") || "(no matches)", ctx.maxOutputBytes);
      return {
        callId: "",
        name: "grep",
        ok: true,
        content: t.text,
        truncated: t.truncated
          ? { keptBytes: t.keptBytes, droppedBytes: t.droppedBytes, pageToken: t.pageToken }
          : undefined,
        data: { count: lines.length, engine: ripgrepAvailable ? "ripgrep" : "node" }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { callId: "", name: "grep", ok: false, content: message, error: message };
    }
  }
};

function ripgrep(
  pattern: string,
  root: string,
  workspaceDir: string,
  args: Record<string, unknown>,
  maxResults: number,
  signal?: AbortSignal
): Promise<string[]> {
  const argv = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(maxResults)
  ];
  if (args.caseInsensitive) argv.push("-i");
  if (typeof args.glob === "string" && args.glob) argv.push("--glob", args.glob);
  argv.push("--regexp", pattern, "--", ".");
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "rg",
      argv,
      { cwd: root, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, signal },
      (err, stdout) => {
        if (
          err &&
          (err as { code?: number }).code !== 1 &&
          (err as { code?: string }).code !== "1"
        ) {
          if ((err as { code?: string }).code === "ABORT_ERR") return resolvePromise([]);

          return nodeGrep(pattern, root, workspaceDir, args, maxResults)
            .then(resolvePromise)
            .catch(() => rejectPromise(err));
        }
        const out = String(stdout ?? "")
          .split("\n")
          .filter(Boolean)
          .slice(0, maxResults);
        resolvePromise(out);
      }
    );
  });
}

async function nodeGrep(
  pattern: string,
  root: string,
  workspaceDir: string,
  args: Record<string, unknown>,
  maxResults: number
): Promise<string[]> {
  const re = new RegExp(pattern, args.caseInsensitive ? "i" : "");
  const { readdir } = await import("node:fs/promises");
  const { relative, join } = await import("node:path");
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0 && files.length < 50_000) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(join(cur, e.name));
      } else if (e.isFile()) files.push(join(cur, e.name));
    }
  }
  const lines: string[] = [];
  for (const file of files) {
    if (lines.length >= maxResults) break;
    const rel = relative(workspaceDir, file).split("\\").join("/");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    const fileLines = text.split("\n");
    for (let i = 0; i < fileLines.length && lines.length < maxResults; i += 1) {
      if (re.test(fileLines[i]!)) lines.push(`${rel}:${i + 1}:${fileLines[i]}`);
    }
  }
  return lines;
}

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    "Find files by glob pattern relative to the workspace (supports * and **). Skips node_modules/.git/dist/runs.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob, e.g. src/**/*.ts or *.md." },
      path: { type: "string", description: "Directory to search (default workspace root)." },
      maxResults: { type: "number", description: "Max files to return (default 200)." }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "");
    const base = String(args.path ?? ".");
    const maxResults = Math.min(5000, Math.max(1, Number(args.maxResults ?? 200) || 200));
    try {
      const root = resolveInside(ctx.workspaceDir, base);
      const re = globToRegExp(pattern);
      const files = await walkFiles(ctx.workspaceDir, root, 50_000);
      const matches: string[] = [];
      for (const f of files) {
        if (re.test(f) || re.test(f.split("/").pop() ?? "")) {
          matches.push(f);
          if (matches.length >= maxResults) break;
        }
      }
      const t = truncateOutput(matches.join("\n") || "(no matches)", ctx.maxOutputBytes);
      return {
        callId: "",
        name: "glob",
        ok: true,
        content: t.text,
        truncated: t.truncated
          ? { keptBytes: t.keptBytes, droppedBytes: t.droppedBytes, pageToken: t.pageToken }
          : undefined,
        data: { count: matches.length }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { callId: "", name: "glob", ok: false, content: message, error: message };
    }
  }
};

async function walkFiles(workspaceDir: string, root: string, maxFiles: number): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { relative, join } = await import("node:path");
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(join(cur, e.name));
      } else if (e.isFile()) {
        out.push(relative(workspaceDir, join(cur, e.name)).split("\\").join("/"));
      }
    }
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          re += "(?:.*/)?";
          i += 1;
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$+.()|{}[]".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveInside } from "./paths.js";
import { truncateOutput } from "./truncate.js";

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
  "target"
]);

async function walk(root: string, dir: string, maxFiles: number): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [dir];
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
        out.push(join(cur, e.name));
      }
    }
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        // `**/` matches zero or more directories, so `**/*.ts` also matches `a.ts`.
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
      const files = await walk(ctx.workspaceDir, root, 50_000);
      const matches: string[] = [];
      for (const f of files) {
        const rel = relative(ctx.workspaceDir, f).split("\\").join("/");
        if (re.test(rel) || re.test(rel.split("/").pop() ?? "")) {
          matches.push(rel);
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

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression. Returns file:line:match lines. Optionally restrict with `glob` and `path`.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regex source." },
      path: { type: "string", description: "Directory to search (default workspace root)." },
      glob: { type: "string", description: "Only search files matching this glob." },
      maxResults: { type: "number", description: "Max matching lines (default 200)." },
      caseInsensitive: { type: "boolean", description: "Case-insensitive search." }
    },
    required: ["pattern"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    let re: RegExp;
    try {
      re = new RegExp(String(args.pattern ?? ""), args.caseInsensitive ? "i" : "");
    } catch (err) {
      const message = `invalid regex: ${err instanceof Error ? err.message : String(err)}`;
      return { callId: "", name: "grep", ok: false, content: message, error: message };
    }
    const base = String(args.path ?? ".");
    const glob = typeof args.glob === "string" && args.glob ? globToRegExp(args.glob) : null;
    const maxResults = Math.min(5000, Math.max(1, Number(args.maxResults ?? 200) || 200));
    try {
      const root = resolveInside(ctx.workspaceDir, base);
      const files = await walk(ctx.workspaceDir, root, 50_000);
      const lines: string[] = [];
      for (const file of files) {
        const rel = relative(ctx.workspaceDir, file).split("\\").join("/");
        if (glob && !glob.test(rel) && !glob.test(rel.split("/").pop() ?? "")) continue;
        let text: string;
        try {
          text = await readFile(file, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue;
        const fileLines = text.split("\n");
        for (let i = 0; i < fileLines.length; i += 1) {
          if (re.test(fileLines[i]!)) {
            lines.push(`${rel}:${i + 1}:${fileLines[i]}`);
            if (lines.length >= maxResults) break;
          }
        }
        if (lines.length >= maxResults) break;
      }
      const t = truncateOutput(lines.join("\n") || "(no matches)", ctx.maxOutputBytes);
      return {
        callId: "",
        name: "grep",
        ok: true,
        content: t.text,
        truncated: t.truncated
          ? { keptBytes: t.keptBytes, droppedBytes: t.droppedBytes, pageToken: t.pageToken }
          : undefined,
        data: { count: lines.length }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { callId: "", name: "grep", ok: false, content: message, error: message };
    }
  }
};

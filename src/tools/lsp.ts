import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { decide } from "./permissions.js";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
}

export function parseTscOutput(output: string, cwd: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/;
  for (const line of output.split("\n")) {
    const m = re.exec(line.trim());
    if (!m) continue;
    const file = m[1]!.startsWith(cwd) ? m[1]!.slice(cwd.length + 1) : m[1]!;
    out.push({
      file,
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] === "warning" ? "warning" : "error",
      code: m[5],
      message: m[6]!
    });
  }
  return out;
}

export function parsePyOutput(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const re = /^(.+?):(\d+):(\d+):\s*([A-Z]\d+)?\s*(.*)$/;
  for (const line of output.split("\n")) {
    const m = re.exec(line.trim());
    if (!m) continue;
    out.push({
      file: m[1]!,
      line: Number(m[2]),
      column: Number(m[3]),
      severity: "error",
      code: m[4],
      message: m[5]!
    });
  }
  return out;
}

function tscCommand(workspaceDir: string): { command: string; prefix: string[] } | null {
  // Prefer the project's own compiler, then a globally installed one. Never use
  // `npx --no-install`: outside a project that vendors `typescript` it exits
  // non-zero with npm's own error text, which used to look like a clean run.
  const local = join(
    workspaceDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc"
  );
  if (existsSync(local)) return { command: local, prefix: [] };
  const js = join(workspaceDir, "node_modules", "typescript", "bin", "tsc");
  if (existsSync(js)) return { command: process.execPath, prefix: [js] };
  return null;
}

function ruffCommand(workspaceDir: string): string | null {
  const local = join(
    workspaceDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "ruff.cmd" : "ruff"
  );
  if (existsSync(local)) return local;
  const path = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of path.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `ruff${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ code: number; output: string } | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, output: out });
    });
  });
}

export const lspTool: ToolDefinition = {
  name: "lsp",
  description:
    "Report diagnostics (type errors, syntax errors) for a file after an edit. Uses tsc for TypeScript/JavaScript and ruff/py_compile for Python. Returns a compact list of file:line:col findings, or 'no diagnostics'.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to check (relative to the workspace)." }
    },
    required: ["path"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const path = String(args.path ?? "");
    if (!path) {
      return {
        callId: "",
        name: "lsp",
        ok: false,
        content: "lsp requires a path",
        error: "no-path"
      };
    }
    const decision = await decide(ctx.permission, "lsp", args);
    if (decision.action === "deny") {
      return {
        callId: "",
        name: "lsp",
        ok: false,
        content: `permission denied (${decision.reason})`,
        error: "permission-denied"
      };
    }
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    if ([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"].includes(ext)) {
      const tsc = tscCommand(ctx.workspaceDir);
      if (!tsc) {
        return {
          callId: "",
          name: "lsp",
          ok: true,
          content:
            "no TypeScript compiler found (install `typescript` in the workspace or globally); skipped diagnostics."
        };
      }
      const res = await run(
        tsc.command,
        [...tsc.prefix, "--noEmit", "--pretty", "false"],
        ctx.workspaceDir,
        60_000
      );
      if (!res) {
        return {
          callId: "",
          name: "lsp",
          ok: true,
          content: "tsc is not available; skipped diagnostics."
        };
      }
      // Match the requested file exactly. A substring test (`output.includes`)
      // made `b.ts` inherit diagnostics from `ab.ts` and `src/sub/b.ts`.
      const want = path.split("\\").join("/").replace(/^\.\//, "");
      const diagnostics = parseTscOutput(res.output, ctx.workspaceDir).filter(
        (d) => d.file.split("\\").join("/").replace(/^\.\//, "") === want
      );
      if (diagnostics.length === 0) {
        // A non-zero exit with no parseable diagnostic means the compiler
        // itself failed (bad tsconfig, missing dependency). Reporting that as
        // "no diagnostics" would hide a real problem.
        if (res.code !== 0 && res.output.trim().length > 0) {
          return {
            callId: "",
            name: "lsp",
            ok: false,
            content: `tsc failed (exit ${res.code}):\n${res.output.trim().slice(0, 4000)}`,
            error: "checker-failed"
          };
        }
        return { callId: "", name: "lsp", ok: true, content: `no diagnostics for ${path}` };
      }
      return {
        callId: "",
        name: "lsp",
        ok: false,
        content: diagnostics
          .slice(0, 50)
          .map((d) => `${d.file}:${d.line}:${d.column} ${d.severity} ${d.code ?? ""} ${d.message}`)
          .join("\n"),
        error: "diagnostics",
        data: { diagnostics }
      };
    }
    if (ext === ".py") {
      const res = ruffCommand(ctx.workspaceDir)
        ? await run(
            ruffCommand(ctx.workspaceDir) ?? "ruff",
            ["check", "--output-format", "concise", path],
            ctx.workspaceDir,
            30_000
          )
        : null;
      if (!res) {
        const py = await run("python3", ["-m", "py_compile", path], ctx.workspaceDir, 30_000);
        if (!py) {
          return {
            callId: "",
            name: "lsp",
            ok: true,
            content: "no Python checker available; skipped."
          };
        }
        if (py.code === 0)
          return { callId: "", name: "lsp", ok: true, content: `no diagnostics for ${path}` };
        return {
          callId: "",
          name: "lsp",
          ok: false,
          content: py.output.trim(),
          error: "diagnostics"
        };
      }
      const diagnostics = parsePyOutput(res.output);
      if (diagnostics.length === 0) {
        return { callId: "", name: "lsp", ok: true, content: `no diagnostics for ${path}` };
      }
      return {
        callId: "",
        name: "lsp",
        ok: false,
        content: diagnostics
          .slice(0, 50)
          .map((d) => `${d.file}:${d.line}:${d.column} ${d.code ?? ""} ${d.message}`)
          .join("\n"),
        error: "diagnostics",
        data: { diagnostics }
      };
    }
    return {
      callId: "",
      name: "lsp",
      ok: true,
      content: `no checker configured for ${ext || "this file"}`
    };
  }
};

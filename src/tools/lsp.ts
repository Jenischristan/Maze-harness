import { spawn } from "node:child_process";
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
      const res = await run(
        "npx",
        ["--no-install", "tsc", "--noEmit", "--pretty", "false"],
        ctx.workspaceDir,
        60_000
      );
      if (!res) {
        return {
          callId: "",
          name: "lsp",
          ok: true,
          content: "tsc is not available (npx/tsc not installed); skipped diagnostics."
        };
      }
      // Match the requested file exactly. A substring test (`output.includes`)
      // made `b.ts` inherit diagnostics from `ab.ts` and `src/sub/b.ts`.
      const want = path.split("\\").join("/").replace(/^\.\//, "");
      const diagnostics = parseTscOutput(res.output, ctx.workspaceDir).filter(
        (d) => d.file.split("\\").join("/").replace(/^\.\//, "") === want
      );
      if (diagnostics.length === 0) {
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
      const res = await run(
        "ruff",
        ["check", "--output-format", "concise", path],
        ctx.workspaceDir,
        30_000
      );
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

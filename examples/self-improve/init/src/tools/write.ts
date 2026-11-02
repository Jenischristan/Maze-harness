import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveInside } from "./paths.js";

export const writeTool: ToolDefinition = {
  name: "write",
  description:
    "Create or overwrite a UTF-8 file relative to the workspace. Fails loudly if the file already exists unless `overwrite: true`. Prefer edit for surgical changes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace." },
      content: { type: "string", description: "Full file content." },
      overwrite: { type: "boolean", description: "Allow clobbering an existing file." }
    },
    required: ["path", "content"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const path = String(args.path ?? "");
    const content = String(args.content ?? "");
    const overwrite = Boolean(args.overwrite);
    try {
      const full = resolveInside(ctx.workspaceDir, path);
      if (!overwrite && existsSync(full) && !ctx.readFiles.has(full) && !ctx.modifiedFiles.has(full)) {
        const prior = await readFile(full, "utf8").catch(() => "");
        return {
          callId: "",
          name: "write",
          ok: false,
          content: `refusing to overwrite ${path}: read it first or pass overwrite: true (${prior.length} bytes exist)`,
          error: "write-before-read"
        };
      }
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
      ctx.modifiedFiles.add(full);
      return {
        callId: "",
        name: "write",
        ok: true,
        content: `wrote ${path} (${Buffer.byteLength(content)} bytes)`,
        data: { path: full, bytes: Buffer.byteLength(content) }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { callId: "", name: "write", ok: false, content: `write failed: ${message}`, error: message };
    }
  }
};

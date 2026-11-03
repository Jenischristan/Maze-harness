import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveInside } from "./paths.js";
import { writeFileAtomic } from "../util/atomic.js";

export const writeTool: ToolDefinition = {
  name: "write",
  description:
    "Create or overwrite a UTF-8 file relative to the workspace. Fails loudly if the file already exists unless `overwrite: true`. The file must have been read in this session, or be new, before it can be overwritten. Prefer edit for surgical changes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace." },
      content: { type: "string", description: "Full file content." },
      overwrite: { type: "boolean", description: "Allow clobbering an existing file." },
      forceUnread: {
        type: "boolean",
        description:
          "Explicitly allow overwriting a file that was never read. Requires overwrite: true and should be used only when the caller knows the content is expendable."
      }
    },
    required: ["path", "content"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const path = String(args.path ?? "");
    const content = String(args.content ?? "");
    const overwrite = Boolean(args.overwrite);
    const forceUnread = Boolean(args.forceUnread);
    try {
      const full = resolveInside(ctx.workspaceDir, path);
      const exists = existsSync(full);
      const wasRead = ctx.readFiles.has(full) || ctx.modifiedFiles.has(full);
      if (exists && !overwrite) {
        const prior = await readFile(full, "utf8").catch(() => "");
        return {
          callId: "",
          name: "write",
          ok: false,
          content: `refusing to overwrite ${path}: pass overwrite: true (${prior.length} bytes exist)`,
          error: "write-before-read"
        };
      }

      if (exists && !wasRead && !(overwrite && forceUnread)) {
        const prior = await readFile(full, "utf8").catch(() => "");
        return {
          callId: "",
          name: "write",
          ok: false,
          content: `refusing to overwrite ${path}: read it first, or pass overwrite: true and forceUnread: true (${prior.length} bytes exist)`,
          error: "write-before-read"
        };
      }
      await mkdir(dirname(full), { recursive: true });

      await writeFileAtomic(full, content, "utf8");
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
      return {
        callId: "",
        name: "write",
        ok: false,
        content: `write failed: ${message}`,
        error: message
      };
    }
  }
};

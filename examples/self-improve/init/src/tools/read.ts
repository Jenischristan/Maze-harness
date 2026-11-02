import { readFile } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveInside } from "./paths.js";
import { truncateOutput } from "./truncate.js";

const MAX_LINES = 2000;

export const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read a UTF-8 file relative to the workspace. Optionally paginate with offset/limit (1-indexed line numbers). Output is truncated to 2000 lines or the byte budget, with a page token to retrieve the full content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace." },
      offset: { type: "number", description: "1-indexed first line to return." },
      limit: { type: "number", description: "Maximum number of lines to return." }
    },
    required: ["path"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const path = String(args.path ?? "");
    const offset = Math.max(1, Number(args.offset ?? 1) || 1);
    const limit = Math.min(MAX_LINES, Math.max(1, Number(args.limit ?? MAX_LINES) || MAX_LINES));
    try {
      const full = resolveInside(ctx.workspaceDir, path);
      const raw = await readFile(full, "utf8");
      const lines = raw.split("\n");
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = selected.map((l, i) => `${offset + i}\t${l}`).join("\n");
      const t = truncateOutput(numbered, ctx.maxOutputBytes, "head");
      ctx.readFiles.add(full);
      return {
        callId: "",
        name: "read",
        ok: true,
        content: t.text,
        truncated: t.truncated
          ? { keptBytes: t.keptBytes, droppedBytes: t.droppedBytes, pageToken: t.pageToken }
          : undefined,
        data: { path: full, lines: selected.length, totalLines: lines.length }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { callId: "", name: "read", ok: false, content: `read failed: ${message}`, error: message };
    }
  }
};

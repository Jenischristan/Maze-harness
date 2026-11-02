import type { ToolDefinition, ToolResult } from "../types.js";
import { getPage } from "./truncate.js";

/**
 * Redeem a `pageToken` returned by a truncating tool.
 *
 * Truncating tools embed `full output page=<token>` in their output; without
 * this tool that promise was unfulfillable and the model silently worked from
 * truncated text.
 */
export const pageTool: ToolDefinition = {
  name: "page",
  description:
    "Retrieve the full, untruncated output of an earlier tool call by its page token (shown as `full output page=<token>`).",
  parameters: {
    type: "object",
    properties: {
      token: { type: "string", description: "Page token from a truncated tool result." }
    },
    required: ["token"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const token = String(args.token ?? "");
    const full = getPage(token);
    if (full === null) {
      return {
        callId: "",
        name: "page",
        ok: false,
        content: `unknown or expired page token: ${token}`,
        error: "page-not-found"
      };
    }
    const bytes = Buffer.byteLength(full);
    if (bytes > ctx.maxOutputBytes) {
      // Still return the beginning so the model has something useful.
      return {
        callId: "",
        name: "page",
        ok: true,
        content: `[page ${token}: ${bytes} bytes, showing first ${ctx.maxOutputBytes}]\n${full.slice(0, ctx.maxOutputBytes)}`,
        data: { token, bytes }
      };
    }
    return { callId: "", name: "page", ok: true, content: full, data: { token, bytes } };
  }
};

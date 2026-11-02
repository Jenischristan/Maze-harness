import { readFile, writeFile } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveInside } from "./paths.js";

export interface EditOp {
  oldText: string;
  newText: string;
}

function fail(message: string, error: string): ToolResult {
  return { callId: "", name: "edit", ok: false, content: message, error };
}

/**
 * Exact-match replacement. Each oldText must appear exactly once in the file and
 * edits must not overlap. Fails loudly if the file changed since it was read or
 * was never read. All edits are matched against the original content.
 */
export const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Make exact-match replacements in a file. Each edits[].oldText must match the file exactly and uniquely; all edits are applied against the original content. The file must have been read in this session. Fails loudly on any mismatch or overlap.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace." },
      edits: {
        type: "array",
        description: "One or more {oldText,newText} replacements.",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" }
          },
          required: ["oldText", "newText"],
          additionalProperties: false
        }
      }
    },
    required: ["path", "edits"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const path = String(args.path ?? "");
    const edits = Array.isArray(args.edits) ? (args.edits as EditOp[]) : [];
    if (edits.length === 0) return fail("edit requires at least one {oldText,newText}", "no-edits");
    let full: string;
    try {
      full = resolveInside(ctx.workspaceDir, path);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), "bad-path");
    }
    if (!ctx.readFiles.has(full)) {
      return fail(`refusing to edit ${path}: read it first`, "edit-before-read");
    }
    let original: string;
    try {
      original = await readFile(full, "utf8");
    } catch (err) {
      return fail(`edit failed reading ${path}: ${err instanceof Error ? err.message : String(err)}`, "read-error");
    }
    const spans: Array<{ start: number; end: number }> = [];
    for (const [i, op] of edits.entries()) {
      if (typeof op.oldText !== "string" || op.oldText.length === 0) {
        return fail(`edit[${i}].oldText must be a non-empty string`, "bad-oldText");
      }
      const first = original.indexOf(op.oldText);
      if (first === -1) {
        return fail(`edit[${i}] oldText not found in ${path} (file may have changed since read)`, "oldText-not-found");
      }
      const second = original.indexOf(op.oldText, first + 1);
      if (second !== -1) {
        return fail(`edit[${i}] oldText is not unique in ${path}`, "oldText-not-unique");
      }
      spans.push({ start: first, end: first + op.oldText.length });
    }
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i]!.start < sorted[i - 1]!.end) {
        return fail("edits overlap; merge nearby changes into one edit", "overlapping-edits");
      }
    }
    const order = [...edits.keys()].sort((a, b) => spans[a]!.start - spans[b]!.start);
    let out = "";
    let pos = 0;
    for (const idx of order) {
      const span = spans[idx]!;
      out += original.slice(pos, span.start);
      out += edits[idx]!.newText;
      pos = span.end;
    }
    out += original.slice(pos);
    try {
      await writeFile(full, out, "utf8");
    } catch (err) {
      return fail(`edit failed writing ${path}: ${err instanceof Error ? err.message : String(err)}`, "write-error");
    }
    ctx.modifiedFiles.add(full);
    return {
      callId: "",
      name: "edit",
      ok: true,
      content: `applied ${edits.length} edit(s) to ${path}`,
      data: { path: full, edits: edits.length }
    };
  }
};

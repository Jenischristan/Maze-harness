import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveInside } from "./paths.js";
import { writeFileAtomic } from "../util/atomic.js";

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

interface EditOp {
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
    // Stale-file guard: if the file changed on disk since the agent read it
    // (another tool, bash, an external editor), refuse. Checking only
    // "was it read" lets a stale edit silently apply to different content.
    const seen = ctx.readHashes?.get(full);
    if (seen !== undefined && seen !== hash(original)) {
      return fail(`refusing to edit ${path}: file changed since it was read`, "stale-file");
    }
    // CRLF files are common; the model emits LF. If a direct match fails and
    // the file is CRLF, retry against an LF-normalized view and re-apply CRLF
    // on write. Offsets stay aligned because we only normalize after a miss.
    const crlf = original.includes("\r\n");
    const normalized = crlf ? original.replace(/\r\n/g, "\n") : original;
    const matchText = (needle: string): { idx: number; text: string } => {
      const direct = original.indexOf(needle);
      if (direct !== -1 || !crlf || needle.includes("\r\n")) {
        return { idx: direct, text: original };
      }
      return { idx: normalized.indexOf(needle), text: normalized };
    };
    const spans: Array<{ start: number; end: number; base: string }> = [];
    for (const [i, op] of edits.entries()) {
      if (typeof op.oldText !== "string" || op.oldText.length === 0) {
        return fail(`edit[${i}].oldText must be a non-empty string`, "bad-oldText");
      }
      const m = matchText(op.oldText);
      if (m.idx === -1) {
        return fail(`edit[${i}] oldText not found in ${path} (file may have changed since read)`, "oldText-not-found");
      }
      const second = m.text.indexOf(op.oldText, m.idx + 1);
      if (second !== -1) {
        return fail(`edit[${i}] oldText is not unique in ${path}`, "oldText-not-unique");
      }
      spans.push({ start: m.idx, end: m.idx + op.oldText.length, base: m.text });
    }
    // All matches must be against the same view (either raw or LF-normalized).
    if (spans.some((s) => s.base !== spans[0]!.base)) {
      return fail("edits matched different line-ending views; split the edit", "mixed-endings");
    }
    const base = spans[0]!.base;
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
      out += base.slice(pos, span.start);
      out += edits[idx]!.newText;
      pos = span.end;
    }
    out += base.slice(pos);
    // A match against the LF-normalized view must be written back as CRLF so
    // the file keeps its original line endings.
    if (base !== original) out = out.replace(/\n/g, "\r\n");
    try {
      // Atomic + mode-preserving: a crash mid-write must not truncate the file,
      // and rewriting an executable script must keep its `+x` bit.
      await writeFileAtomic(full, out, "utf8");
    } catch (err) {
      return fail(`edit failed writing ${path}: ${err instanceof Error ? err.message : String(err)}`, "write-error");
    }
    ctx.modifiedFiles.add(full);
    ctx.readHashes?.set(full, hash(out));
    return {
      callId: "",
      name: "edit",
      ok: true,
      content: `applied ${edits.length} edit(s) to ${path}`,
      data: { path: full, edits: edits.length }
    };
  }
};

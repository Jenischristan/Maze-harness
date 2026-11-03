import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveInside } from "./paths.js";
import { writeFileAtomic } from "../util/atomic.js";
import { findFuzzy } from "./fuzzy-match.js";

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
      return fail(
        `edit failed reading ${path}: ${err instanceof Error ? err.message : String(err)}`,
        "read-error"
      );
    }

    const seen = ctx.readHashes?.get(full);
    if (seen !== undefined && seen !== hash(original)) {
      return fail(`refusing to edit ${path}: file changed since it was read`, "stale-file");
    }

    const crlf = original.includes("\r\n");
    const normalized = crlf ? original.replace(/\r\n/g, "\n") : original;
    const matchText = (
      needle: string
    ): { idx: number; end: number; text: string; strategy: string } => {
      const direct = original.indexOf(needle);
      if (direct !== -1) {
        return { idx: direct, end: direct + needle.length, text: original, strategy: "exact" };
      }
      if (crlf && !needle.includes("\r\n")) {
        const n = normalized.indexOf(needle);
        if (n !== -1) {
          return { idx: n, end: n + needle.length, text: normalized, strategy: "exact" };
        }
      }

      const fuzzy = findFuzzy(normalized, needle);
      if (fuzzy.match) {
        return {
          idx: fuzzy.match.start,
          end: fuzzy.match.end,
          text: normalized,
          strategy: fuzzy.match.strategy
        };
      }
      return { idx: -1, end: -1, text: normalized, strategy: "none" };
    };
    const spans: Array<{ start: number; end: number; base: string }> = [];
    for (const [i, op] of edits.entries()) {
      if (typeof op.oldText !== "string" || op.oldText.length === 0) {
        return fail(`edit[${i}].oldText must be a non-empty string`, "bad-oldText");
      }
      const m = matchText(op.oldText);
      if (m.idx === -1) {
        return fail(
          `edit[${i}] oldText not found in ${path} (file may have changed since read)`,
          "oldText-not-found"
        );
      }

      const matched = m.text.slice(m.idx, m.end);
      const second = m.text.indexOf(matched, m.idx + matched.length);
      if (second !== -1) {
        return fail(`edit[${i}] oldText is not unique in ${path}`, "oldText-not-unique");
      }
      spans.push({ start: m.idx, end: m.end, base: m.text });
    }

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

    if (base !== original) out = out.replace(/\n/g, "\r\n");
    if (args.dryRun) {
      // Planning mode (used by multiedit): compute the result without touching
      // the file so a later failure can abort the whole batch.
      return {
        callId: "",
        name: "edit",
        ok: true,
        content: `dry-run: would apply ${edits.length} edit(s) to ${path}`,
        data: { path: full, edits: edits.length, next: out }
      };
    }
    try {
      await writeFileAtomic(full, out, "utf8");
    } catch (err) {
      return fail(
        `edit failed writing ${path}: ${err instanceof Error ? err.message : String(err)}`,
        "write-error"
      );
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

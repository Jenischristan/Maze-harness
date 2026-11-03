import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveInside } from "./paths.js";
import { writeFileAtomic } from "../util/atomic.js";

interface Hunk {
  oldText: string;

  newText: string;
}

interface FilePatch {
  path: string;
  hunks: Hunk[];

  create?: boolean;

  delete?: boolean;
}

export class PatchParseError extends Error {}

function fail(message: string, error: string): ToolResult {
  return { callId: "", name: "apply_patch", ok: false, content: message, error };
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export function parsePatch(input: string): FilePatch[] {
  const lines = input.split("\n");
  const files: FilePatch[] = [];
  let current: FilePatch | null = null;
  let hunkLines: string[] | null = null;
  let sawBegin = false;

  const flushHunk = (): void => {
    if (!current || hunkLines === null) return;
    const body = hunkLines.join("\n");
    const sep = body.indexOf("\n***NEW***\n");
    if (sep === -1) {
      const trimmed = body.replace(/\n+$/, "");
      current.hunks.push({ oldText: trimmed, newText: "" });
    } else {
      current.hunks.push({
        oldText: body.slice(0, sep).replace(/\n+$/, ""),
        newText: body.slice(sep + "\n***NEW***\n".length).replace(/\n+$/, "")
      });
    }
    hunkLines = null;
  };

  const flushFile = (): void => {
    flushHunk();
    if (current) files.push(current);
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "*** Begin Patch") {
      sawBegin = true;
      continue;
    }
    if (trimmed === "*** End Patch") {
      flushFile();
      continue;
    }
    if (trimmed.startsWith("*** Update File:")) {
      flushFile();
      const path = trimmed.slice("*** Update File:".length).trim();
      if (!path) throw new PatchParseError("Update File directive has no path");
      current = { path, hunks: [] };
      continue;
    }
    if (trimmed.startsWith("*** Add File:")) {
      flushFile();
      const path = trimmed.slice("*** Add File:".length).trim();
      if (!path) throw new PatchParseError("Add File directive has no path");
      current = { path, hunks: [{ oldText: "", newText: "" }], create: true };
      continue;
    }
    if (trimmed.startsWith("*** Delete File:")) {
      flushFile();
      const path = trimmed.slice("*** Delete File:".length).trim();
      if (!path) throw new PatchParseError("Delete File directive has no path");
      current = { path, hunks: [], delete: true };
      continue;
    }
    if (trimmed === "@@") {
      flushHunk();
      hunkLines = [];
      continue;
    }
    // Hunk bodies (including the `***NEW***` separator) are raw content, so
    // they must be handled before the directive guard below.
    if (hunkLines !== null) {
      hunkLines.push(line);
      continue;
    }
    if (trimmed.startsWith("***")) {
      throw new PatchParseError(`unknown patch directive: ${trimmed.slice(0, 60)}`);
    }
    if (current?.create) {
      current.hunks[0]!.newText = current.hunks[0]!.newText
        ? `${current.hunks[0]!.newText}\n${line}`
        : line;
    } else if (trimmed.length > 0) {
      throw new PatchParseError(`unexpected content before a hunk: ${trimmed.slice(0, 60)}`);
    }
  }
  if (current) flushFile();
  if (!sawBegin && files.length === 0) {
    throw new PatchParseError("missing '*** Begin Patch' header");
  }
  if (files.length === 0) throw new PatchParseError("patch contains no file directives");
  return files;
}

export function applyFilePatch(original: string, patch: FilePatch): string {
  if (patch.delete) return "";
  if (patch.create) {
    return patch.hunks[0]?.newText ?? "";
  }
  const crlf = original.includes("\r\n");
  const base = crlf ? original.replace(/\r\n/g, "\n") : original;
  let out = base;
  for (const [i, hunk] of patch.hunks.entries()) {
    const first = out.indexOf(hunk.oldText);
    if (first === -1) {
      throw new Error(`${patch.path}: hunk ${i + 1} oldText not found`);
    }
    if (out.indexOf(hunk.oldText, first + 1) !== -1) {
      throw new Error(`${patch.path}: hunk ${i + 1} oldText is not unique`);
    }
    out = out.slice(0, first) + hunk.newText + out.slice(first + hunk.oldText.length);
  }
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

export const applyPatchTool: ToolDefinition = {
  name: "apply_patch",
  description:
    "Apply a multi-file patch atomically. Format: '*** Begin Patch' then one or more of '*** Update File: <path>' / '*** Add File: <path>' / '*** Delete File: <path>', each Update block containing one or more '@@' hunks whose body is '<exact old text>' + a line '***NEW***' + '<replacement>'. Every hunk is validated against the current file contents before anything is written; if any hunk is invalid, no file changes.",
  parameters: {
    type: "object",
    properties: {
      patch: { type: "string", description: "The patch text." }
    },
    required: ["patch"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const text = String(args.patch ?? "");
    let files: FilePatch[];
    try {
      files = parsePatch(text);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), "bad-patch");
    }

    const planned: Array<{
      path: string;
      full: string;
      original: string;
      next: string;
      delete?: boolean;
    }> = [];
    const seen = new Set<string>();
    for (const file of files) {
      let full: string;
      try {
        full = resolveInside(ctx.workspaceDir, file.path);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err), "bad-path");
      }
      if (seen.has(full)) return fail(`duplicate file in patch: ${file.path}`, "duplicate-file");
      seen.add(full);
      if (!ctx.readFiles.has(full) && !file.create) {
        return fail(`refusing to patch ${file.path}: read it first`, "patch-before-read");
      }
      let original = "";
      if (!file.create) {
        try {
          original = await readFile(full, "utf8");
        } catch (err) {
          return fail(
            `cannot read ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
            "read-error"
          );
        }
        const seenHash = ctx.readHashes?.get(full);
        if (seenHash !== undefined && seenHash !== hash(original)) {
          return fail(
            `refusing to patch ${file.path}: file changed since it was read`,
            "stale-file"
          );
        }
      }
      let next: string;
      try {
        next = applyFilePatch(original, file);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err), "bad-hunk");
      }
      planned.push({ path: file.path, full, original, next, delete: file.delete });
    }

    const written: Array<{ full: string; original: string; deleted: boolean }> = [];
    try {
      for (const item of planned) {
        if (item.delete) {
          // A delete must remove the file, not leave an empty one behind.
          await rm(item.full, { force: true });
          written.push({ full: item.full, original: item.original, deleted: true });
        } else {
          await writeFileAtomic(item.full, item.next, "utf8");
          written.push({ full: item.full, original: item.original, deleted: false });
        }
        ctx.modifiedFiles.add(item.full);
        ctx.readHashes?.delete(item.full);
        if (!item.delete) {
          ctx.readHashes?.set(item.full, hash(item.next));
          ctx.readFiles.add(item.full);
        }
      }
    } catch (err) {
      for (const undo of written.reverse()) {
        try {
          await writeFileAtomic(undo.full, undo.original, "utf8");
          ctx.readHashes?.set(undo.full, hash(undo.original));
        } catch {
          void 0;
        }
      }
      return fail(
        `patch failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
        "write-error"
      );
    }
    return {
      callId: "",
      name: "apply_patch",
      ok: true,
      content: `patched ${planned.length} file(s): ${planned.map((p) => p.path).join(", ")}`,
      data: { files: planned.map((p) => ({ path: p.path, deleted: Boolean(p.delete) })) }
    };
  }
};

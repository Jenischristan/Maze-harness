import type { ToolDefinition, ToolResult } from "../types.js";
import { editTool } from "./edit.js";

export const multieditTool: ToolDefinition = {
  name: "multiedit",
  description:
    "Apply exact-match edits across one or more files atomically. Each file gets its own read-before-edit and stale-file check; if any edit fails, no file is changed.",
  parameters: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            edits: {
              type: "array",
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
        }
      }
    },
    required: ["files"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const files = Array.isArray(args.files)
      ? (args.files as Array<{ path: string; edits: Array<{ oldText: string; newText: string }> }>)
      : [];
    if (files.length === 0) {
      return {
        callId: "",
        name: "multiedit",
        ok: false,
        content: "multiedit requires files",
        error: "no-files"
      };
    }
    const { writeFileAtomic } = await import("../util/atomic.js");
    const { resolveInside } = await import("./paths.js");
    const { createHash } = await import("node:crypto");

    // Phase 1: compute every file's new content without touching disk. Any
    // failure here aborts before a single byte is written.
    const planned: Array<{ path: string; full: string; next: string; previous: string }> = [];
    const seen = new Set<string>();
    for (const file of files) {
      const dry = await editTool.execute({ path: file.path, edits: file.edits, dryRun: true }, ctx);
      if (!dry.ok) return { ...dry, name: "multiedit" };
      const next =
        dry.data && typeof dry.data === "object" && "next" in dry.data
          ? String((dry.data as { next: unknown }).next)
          : null;
      if (next === null) {
        return {
          callId: "",
          name: "multiedit",
          ok: false,
          content: `internal error computing edits for ${file.path}`,
          error: "multiedit-internal"
        };
      }
      const full = resolveInside(ctx.workspaceDir, file.path);
      if (seen.has(full)) {
        return {
          callId: "",
          name: "multiedit",
          ok: false,
          content: `duplicate file in multiedit: ${file.path}`,
          error: "multiedit-duplicate"
        };
      }
      seen.add(full);
      const previous = await import("node:fs/promises").then((fs) =>
        fs.readFile(full, "utf8").catch(() => "")
      );
      planned.push({ path: file.path, full, next, previous });
    }

    // Phase 2: commit. If a write fails midway, restore the files already
    // written so the batch stays all-or-nothing.
    const written: Array<{ full: string; previous: string }> = [];
    try {
      for (const item of planned) {
        await writeFileAtomic(item.full, item.next, "utf8");
        written.push({ full: item.full, previous: item.previous });
      }
    } catch (err) {
      for (const item of written.reverse()) {
        await writeFileAtomic(item.full, item.previous, "utf8").catch(() => undefined);
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId: "",
        name: "multiedit",
        ok: false,
        content: `multiedit rolled back after a write failure: ${message}`,
        error: "multiedit-write-failed"
      };
    }

    for (const item of planned) {
      ctx.modifiedFiles.add(item.full);
      ctx.readFiles.add(item.full);
      ctx.readHashes?.set(item.full, createHash("sha1").update(item.next).digest("hex"));
    }
    return {
      callId: "",
      name: "multiedit",
      ok: true,
      content: `applied edits to ${planned.length} file(s): ${planned.map((p) => p.path).join(", ")}`,
      data: { files: planned.map((p) => p.path) }
    };
  }
};

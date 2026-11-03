import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveInside } from "./paths.js";
import { truncateOutput } from "./truncate.js";

const MAX_LINES = 2000;

/**
 * Extensions we know are binary. Reading one as UTF-8 silently produces
 * replacement characters and a useless "content" the model then reasons about,
 * so refuse with a clear message instead.
 */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".tiff",
  ".avif",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".tar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".class",
  ".jar",
  ".wasm",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".mov",
  ".avi",
  ".flac",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".sqlite",
  ".db",
  ".bin",
  ".pyc"
]);

/** Detect binary content by a NUL byte in the first 8 KiB. */
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function decodeText(buf: Buffer): { text: string; encoding: string } {
  // Strip a UTF-8 BOM so the model does not see an invisible leading character.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString("utf8"), encoding: "utf8-bom" };
  }
  const utf16le = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  if (utf16le) return { text: buf.subarray(2).toString("utf16le"), encoding: "utf16le" };
  return { text: buf.toString("utf8"), encoding: "utf8" };
}

function summarizeNotebook(text: string): string | null {
  // A .ipynb is JSON; render its cells as a compact transcript rather than
  // dumping raw JSON that the model has to parse by eye.
  try {
    const nb = JSON.parse(text) as {
      cells?: Array<{ cell_type?: string; source?: string | string[]; outputs?: unknown[] }>;
    };
    if (!Array.isArray(nb.cells)) return null;
    const out: string[] = ["# Notebook"];
    for (const [i, cell] of nb.cells.entries()) {
      const src = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");
      out.push("", `## Cell ${i + 1} (${cell.cell_type ?? "unknown"})`, src);
      if (cell.outputs && cell.outputs.length > 0) {
        out.push(`(${cell.outputs.length} output(s))`);
      }
    }
    return out.join("\n");
  } catch {
    return null;
  }
}

export const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read a UTF-8 text file relative to the workspace. Optionally paginate with offset/limit (1-indexed line numbers). Notebooks (.ipynb) are rendered as cells. Binary files are refused. Output is truncated to 2000 lines or the byte budget, with a page token to retrieve the full content.",
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
      const buf = await readFile(full);
      const ext = extname(path).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext) || looksBinary(buf)) {
        return {
          callId: "",
          name: "read",
          ok: false,
          content: `refusing to read ${path}: binary file (${buf.length} bytes, ${ext || "no extension"}). Use a dedicated tool for images/PDFs/notebooks.`,
          error: "binary-file"
        };
      }
      const { text: decoded, encoding } = decodeText(buf);
      const text = ext === ".ipynb" ? (summarizeNotebook(decoded) ?? decoded) : decoded;
      const lines = text.split("\n");
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = selected.map((l, i) => `${offset + i}\t${l}`).join("\n");
      const t = truncateOutput(numbered, ctx.maxOutputBytes, "head");
      ctx.readFiles.add(full);
      ctx.readHashes?.set(full, createHash("sha1").update(buf).digest("hex"));
      return {
        callId: "",
        name: "read",
        ok: true,
        content: t.text,
        truncated: t.truncated
          ? { keptBytes: t.keptBytes, droppedBytes: t.droppedBytes, pageToken: t.pageToken }
          : undefined,
        data: {
          path: full,
          lines: selected.length,
          totalLines: lines.length,
          encoding,
          bytes: buf.length,
          crlf: decoded.includes("\r\n")
        }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId: "",
        name: "read",
        ok: false,
        content: `read failed: ${message}`,
        error: message
      };
    }
  }
};

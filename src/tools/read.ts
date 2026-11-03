import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";
import { resolveInside } from "./paths.js";
import { truncateOutput } from "./truncate.js";

const MAX_LINES = 2000;

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

const DOCUMENT_TYPES: Record<string, string> = { ".pdf": "application/pdf" };

const BINARY_EXTENSIONS = new Set([
  ".bmp",
  ".ico",
  ".tiff",
  ".avif",
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

function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function decodeText(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString("utf8"), encoding: "utf8-bom" };
  }
  const utf16le = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  if (utf16le) return { text: buf.subarray(2).toString("utf16le"), encoding: "utf16le" };
  return { text: buf.toString("utf8"), encoding: "utf8" };
}

function summarizeNotebook(text: string): string | null {
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

async function pdfToText(path: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolvePromise) => {
    execFile(
      "pdftotext",
      ["-layout", path, "-"],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) resolvePromise(null);
        else resolvePromise(String(stdout));
      }
    );
  });
}

export const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read a file relative to the workspace. Text files return numbered lines (offset/limit pagination, 1-indexed). Images (png/jpg/gif/webp) return an image content block. PDFs return extracted text when `pdftotext` is available. Notebooks (.ipynb) are rendered as cells. Binary files are refused.",
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
      ctx.readFiles.add(full);
      ctx.readHashes?.set(full, createHash("sha1").update(buf).digest("hex"));

      const imageType = IMAGE_TYPES[ext];
      if (imageType) {
        if (!ctx.mediaTypes?.includes(imageType)) {
          return {
            callId: "",
            name: "read",
            ok: true,
            content: `[image ${path}: ${buf.length} bytes, ${imageType}] The active model does not accept images; describe what you need from it or ask the user.`,
            data: { path: full, bytes: buf.length, mediaType: imageType }
          };
        }
        const block = {
          type: "image" as const,
          mediaType: imageType,
          data: buf.toString("base64")
        };
        return {
          callId: "",
          name: "read",
          ok: true,
          content: `[image ${path}: ${buf.length} bytes, ${imageType}]`,
          data: { path: full, bytes: buf.length, mediaType: imageType },
          contentBlocks: [block]
        };
      }
      const docType = DOCUMENT_TYPES[ext];
      if (docType) {
        const text = await pdfToText(full);
        if (text === null) {
          return {
            callId: "",
            name: "read",
            ok: false,
            content: `cannot extract text from ${path}: pdftotext is not installed. Install poppler-utils, or convert the PDF to text first.`,
            error: "pdf-no-extractor"
          };
        }
        const lines = text.split("\n");
        const selected = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = selected.map((l, i) => `${offset + i}\t${l}`).join("\n");
        const t = truncateOutput(numbered, ctx.maxOutputBytes, "head");
        return {
          callId: "",
          name: "read",
          ok: true,
          content: t.text,
          data: { path: full, lines: selected.length, totalLines: lines.length, mediaType: docType }
        };
      }

      if (BINARY_EXTENSIONS.has(ext) || looksBinary(buf)) {
        return {
          callId: "",
          name: "read",
          ok: false,
          content: `refusing to read ${path}: binary file (${buf.length} bytes, ${ext || "no extension"})`,
          error: "binary-file"
        };
      }
      const { text: decoded, encoding } = decodeText(buf);
      const text = ext === ".ipynb" ? (summarizeNotebook(decoded) ?? decoded) : decoded;
      const lines = text.split("\n");
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = selected.map((l, i) => `${offset + i}\t${l}`).join("\n");
      const t = truncateOutput(numbered, ctx.maxOutputBytes, "head");
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

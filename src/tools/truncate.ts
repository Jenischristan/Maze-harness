import { createHash } from "node:crypto";

export interface TruncationResult {
  text: string;
  truncated: boolean;
  keptBytes: number;
  droppedBytes: number;
  pageToken?: string;
}

const pageCache = new Map<string, { text: string; createdAt: number }>();
const MAX_PAGES = 64;
const PAGE_TTL_MS = 10 * 60 * 1000;

function evict(): void {
  const now = Date.now();
  for (const [k, v] of pageCache) {
    if (now - v.createdAt > PAGE_TTL_MS) pageCache.delete(k);
  }
  while (pageCache.size > MAX_PAGES) {
    const first = pageCache.keys().next().value;
    if (first === undefined) break;
    pageCache.delete(first);
  }
}

export function truncateOutput(
  text: string,
  maxBytes: number,
  mode: "head" | "tail" = "head"
): TruncationResult {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) {
    return { text, truncated: false, keptBytes: bytes, droppedBytes: 0 };
  }
  const token = createHash("sha1").update(text).digest("hex").slice(0, 16);
  pageCache.set(token, { text, createdAt: Date.now() });
  evict();
  const buf = Buffer.from(text, "utf8");

  const start = mode === "tail" ? utf8Start(buf, buf.length - maxBytes) : 0;
  const end = mode === "tail" ? buf.length : utf8End(buf, maxBytes);
  const kept = buf.subarray(start, end).toString("utf8");

  const keptBytes = end - start;
  const dropped = bytes - keptBytes;
  const marker = `[truncated ${dropped} bytes; full output page=${token}]`;
  return {
    text: mode === "tail" ? `${marker}\n${kept}` : `${kept}\n${marker}`,
    truncated: true,
    keptBytes,
    droppedBytes: dropped,
    pageToken: token
  };
}

function utf8Start(buf: Buffer, i: number): number {
  let idx = Math.max(0, i);
  while (idx < buf.length && (buf[idx]! & 0xc0) === 0x80) idx += 1;
  return idx;
}

function utf8End(buf: Buffer, i: number): number {
  let idx = Math.min(buf.length, Math.max(0, i));
  while (idx > 0 && (buf[idx]! & 0xc0) === 0x80) idx -= 1;
  return idx;
}

export function getPage(token: string): string | null {
  const entry = pageCache.get(token);
  return entry ? entry.text : null;
}

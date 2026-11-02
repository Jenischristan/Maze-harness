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

/**
 * Truncate `text` to at most `maxBytes`. `head` keeps the beginning,
 * `tail` keeps the end (errors usually appear last). A page token lets the
 * caller retrieve the full text later via getPage().
 */
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
  // Slice on a UTF-8 boundary: cutting at an arbitrary byte offset would emit
  // U+FFFD for a split multibyte sequence (CJK, emoji).
  const start = mode === "tail" ? utf8Start(buf, buf.length - maxBytes) : 0;
  const end = mode === "tail" ? buf.length : utf8End(buf, maxBytes);
  const kept = buf.subarray(start, end).toString("utf8");
  // Report the bytes actually kept, not the requested budget: the UTF-8
  // boundary trim can drop a few extra bytes, and callers that sum
  // keptBytes + droppedBytes expect them to add up to the input size.
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

/** First index >= `i` that starts a UTF-8 sequence (not a continuation byte). */
function utf8Start(buf: Buffer, i: number): number {
  let idx = Math.max(0, i);
  while (idx < buf.length && (buf[idx]! & 0xc0) === 0x80) idx += 1;
  return idx;
}

/** Largest index <= `i` that ends on a UTF-8 boundary. */
function utf8End(buf: Buffer, i: number): number {
  let idx = Math.min(buf.length, Math.max(0, i));
  while (idx > 0 && (buf[idx]! & 0xc0) === 0x80) idx -= 1;
  return idx;
}

export function getPage(token: string): string | null {
  const entry = pageCache.get(token);
  return entry ? entry.text : null;
}

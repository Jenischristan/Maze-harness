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
  const kept =
    mode === "tail"
      ? buf.subarray(buf.length - maxBytes).toString("utf8")
      : buf.subarray(0, maxBytes).toString("utf8");
  const dropped = bytes - maxBytes;
  const marker = `[truncated ${dropped} bytes; full output page=${token}]`;
  return {
    text: mode === "tail" ? `${marker}\n${kept}` : `${kept}\n${marker}`,
    truncated: true,
    keptBytes: maxBytes,
    droppedBytes: dropped,
    pageToken: token
  };
}

export function getPage(token: string): string | null {
  const entry = pageCache.get(token);
  return entry ? entry.text : null;
}

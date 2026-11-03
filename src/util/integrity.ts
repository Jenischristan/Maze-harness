import { createHash } from "node:crypto";

/**
 * Append-only JSONL integrity helpers.
 *
 * A crash mid-write can leave a truncated final line. `appendLineSafe` already
 * terminates a torn line before appending, but nothing detected *pre-existing*
 * corruption: a session with a bad line silently lost that entry (it was
 * skipped by `JSON.parse` in a catch), which could drop a tool result and make
 * a resumed transcript subtly wrong.
 *
 * These helpers give callers a way to detect and report corruption instead of
 * hiding it:
 *
 *   - `hashLine` / `verifyLine` detect a line that was altered after the fact,
 *   - `scanJsonl` returns parsed records plus an explicit list of bad lines.
 *
 * Hashing is opt-in per record (`__h`) so existing files keep working.
 */

/** Stable hash of a record's payload (everything except `__h`). */
export function hashLine(record: Record<string, unknown>): string {
  const { __h: _ignored, ...payload } = record;
  return createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 16);
}

/** Add an integrity hash to a record before it is serialised. */
export function withIntegrity<T extends Record<string, unknown>>(record: T): T & { __h: string } {
  return { ...record, __h: hashLine(record) };
}

export interface ScanResult<T> {
  records: T[];
  /** 1-based line numbers that were empty-free but unparseable. */
  corrupt: Array<{ line: number; reason: string }>;
  /** Records whose stored hash does not match their payload. */
  tampered: Array<{ line: number; id?: string }>;
}

/**
 * Parse newline-delimited JSON, reporting corruption instead of swallowing it.
 * Empty lines are ignored. A record without `__h` is accepted (legacy file).
 */
export function scanJsonl<T extends Record<string, unknown>>(raw: string): ScanResult<T> {
  const records: T[] = [];
  const corrupt: Array<{ line: number; reason: string }> = [];
  const tampered: Array<{ line: number; id?: string }> = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (err) {
      corrupt.push({
        line: i + 1,
        reason: err instanceof Error ? err.message : String(err)
      });
      continue;
    }
    if (typeof parsed.__h === "string" && parsed.__h !== hashLine(parsed)) {
      tampered.push({ line: i + 1, id: typeof parsed.id === "string" ? parsed.id : undefined });
    }
    records.push(parsed as T);
  }
  return { records, corrupt, tampered };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

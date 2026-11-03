import { createHash } from "node:crypto";

export function hashLine(record: Record<string, unknown>): string {
  const { __h: _ignored, ...payload } = record;
  return createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 16);
}

export function withIntegrity<T extends Record<string, unknown>>(record: T): T & { __h: string } {
  return { ...record, __h: hashLine(record) };
}

export interface ScanResult<T> {
  records: T[];

  corrupt: Array<{ line: number; reason: string }>;

  tampered: Array<{ line: number; id?: string }>;
}

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
  // Mirror JSON.stringify semantics so a hash computed in memory still matches
  // after the record has been persisted and parsed back: undefined values and
  // functions are dropped from objects, and become null inside arrays.
  if (value === null) return "null";
  if (typeof value === "function" || typeof value === "symbol") return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const entries: string[] = [];
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
    entries.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
  }
  return `{${entries.join(",")}}`;
}

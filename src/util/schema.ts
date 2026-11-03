/**
 * Schema versioning and migration for everything the harness persists.
 *
 * Sessions, discovery trees, run state, live manifests and beta sweeps were
 * all written with an implicit shape and no version field (sessions had
 * `meta.version: 1` but nothing read it). Adding a field was therefore a
 * silent breaking change: an older build would read a newer file and either
 * ignore data or misbehave, with no way to detect it.
 *
 * Every persisted record now carries a `schema` integer. Readers call
 * `migrate()` which:
 *
 *   - upgrades an older version through the registered upcasters,
 *   - rejects a *newer* version with a clear error instead of guessing,
 *   - treats a missing version as v1 (files written before this change).
 *
 * Migration functions must be pure, total and forward-only. Each is pinned by
 * a test that loads a v1 fixture and asserts the upgraded shape.
 */

export const CURRENT_SCHEMA = 2;

export class SchemaVersionError extends Error {}

export interface Migratable {
  schema?: number;
  [key: string]: unknown;
}

/** One step: `from` -> `from + 1`. */
export type Upcaster = (record: Migratable) => Migratable;

/**
 * Registry keyed by kind ("session", "tree", "run-state", ...). Keeping a
 * separate chain per kind lets each evolve at its own pace without a global
 * version bump.
 */
const upcasters = new Map<string, Map<number, Upcaster>>();

/**
 * Legacy fields that make an upcaster mandatory. When a record of `kind` still
 * carries one of these, skipping the migration would silently reinterpret it,
 * so `migrate` fails. A record without legacy fields only needs the stamp.
 */
const LEGACY_KEYS: Record<string, readonly string[]> = {
  "live-manifest": ["version"]
};

function hasLegacyShape(kind: string, record: Migratable): boolean {
  const keys = LEGACY_KEYS[kind];
  if (!keys) return false;
  for (const key of keys) {
    if (key in record) return true;
  }
  return false;
}

/** Register the upgrade from `from` to `from + 1` for one record kind. */
export function registerUpcaster(kind: string, from: number, fn: Upcaster): void {
  let chain = upcasters.get(kind);
  if (!chain) {
    chain = new Map();
    upcasters.set(kind, chain);
  }
  chain.set(from, fn);
}

/**
 * Bring `record` up to `CURRENT_SCHEMA`.
 *
 * @param kind    record kind, e.g. "session"
 * @param record  parsed JSON
 * @param target  target version (defaults to CURRENT_SCHEMA; tests pass an
 *                explicit value to exercise one step at a time)
 */
export function migrate<T extends Migratable>(
  kind: string,
  record: T,
  target: number = CURRENT_SCHEMA
): T & { schema: number } {
  if (!record || typeof record !== "object") {
    throw new SchemaVersionError(`${kind}: record is not an object`);
  }
  let version = typeof record.schema === "number" ? record.schema : 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new SchemaVersionError(`${kind}: invalid schema version ${String(record.schema)}`);
  }
  if (version > target) {
    throw new SchemaVersionError(
      `${kind}: file uses schema v${version} but this build supports up to v${target}; upgrade the harness`
    );
  }
  const chain = upcasters.get(kind);
  let current: Migratable = record;
  while (version < target) {
    const step = chain?.get(version);
    if (!step) {
      // A missing upcaster is fatal only when the record still carries a
      // legacy field the newer shape could reinterpret. A record that already
      // has the current shape (plus no schema stamp) needs only the stamp;
      // requiring a no-op function would be ceremony. Kinds with known legacy
      // keys are listed in `LEGACY_KEYS`.
      if (hasLegacyShape(kind, current)) {
        throw new SchemaVersionError(`${kind}: no migration from v${version} to v${version + 1}`);
      }
      break;
    }
    current = step(current);
    version += 1;
    current.schema = version;
  }
  return { ...current, schema: target } as T & { schema: number };
}

/**
 * Stamp the current schema on a record before writing. Writers must call this
 * rather than hard-coding a number so a bump cannot be forgotten.
 */
export function stampSchema<T extends Record<string, unknown>>(record: T): T & { schema: number } {
  return { ...record, schema: CURRENT_SCHEMA };
}

/** True when `kind` has a complete chain from v1 to `CURRENT_SCHEMA`. */
export function hasFullMigrationChain(kind: string): boolean {
  const chain = upcasters.get(kind);
  for (let v = 1; v < CURRENT_SCHEMA; v += 1) {
    if (!chain?.has(v)) return false;
  }
  return true;
}

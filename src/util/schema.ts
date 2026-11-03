export const CURRENT_SCHEMA = 2;

export class SchemaVersionError extends Error {}

export interface Migratable {
  schema?: number;
  [key: string]: unknown;
}

export type Upcaster = (record: Migratable) => Migratable;

const upcasters = new Map<string, Map<number, Upcaster>>();

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

export function registerUpcaster(kind: string, from: number, fn: Upcaster): void {
  let chain = upcasters.get(kind);
  if (!chain) {
    chain = new Map();
    upcasters.set(kind, chain);
  }
  chain.set(from, fn);
}

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
      // No upcaster for this step. A record carrying a known legacy shape must
      // fail loudly rather than being silently stamped with the target version.
      // Otherwise the record is assumed to already have the current on-disk
      // shape, so migration stops and the target version is stamped.
      if (hasLegacyShape(kind, current)) {
        throw new SchemaVersionError(`${kind}: no migration from v${version} to v${version + 1}`);
      }
      break;
    }
    const next = step(current);
    if (!next || typeof next !== "object") {
      throw new SchemaVersionError(`${kind}: upcaster from v${version} returned no record`);
    }
    current = next;
    version += 1;
    current.schema = version;
  }
  return { ...current, schema: target } as T & { schema: number };
}

export function stampSchema<T extends Record<string, unknown>>(record: T): T & { schema: number } {
  return { ...record, schema: CURRENT_SCHEMA };
}

export function hasFullMigrationChain(kind: string): boolean {
  const chain = upcasters.get(kind);
  for (let v = 1; v < CURRENT_SCHEMA; v += 1) {
    if (!chain?.has(v)) return false;
  }
  return true;
}

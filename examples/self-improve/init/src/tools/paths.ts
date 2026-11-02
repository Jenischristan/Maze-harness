import { resolve, sep } from "node:path";

export function resolveInside(root: string, rel: string): string {
  const full = resolve(root, rel || ".");
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  return full;
}

export function isInside(root: string, full: string): boolean {
  const base = resolve(root);
  const target = resolve(full);
  return target === base || target.startsWith(base + sep);
}

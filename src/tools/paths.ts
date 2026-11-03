import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export function resolveInside(root: string, rel: string): string {
  const base = resolve(root);
  const full = resolve(base, rel || ".");
  if (!isInside(base, full)) {
    throw new Error(`path escapes workspace: ${rel}`);
  }
  const realBase = realpathSync(base);
  const realFull = realpathDeepest(full);
  if (!isInside(realBase, realFull)) {
    throw new Error(`path escapes workspace (via symlink): ${rel}`);
  }
  return full;
}

function realpathDeepest(full: string): string {
  let cur = full;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return full;
    tail.unshift(cur.slice(parent.length).replace(/^[/\\]/, ""));
    cur = parent;
  }
  const real = realpathSync(cur);
  return tail.length > 0 ? resolve(real, ...tail) : real;
}

function isInside(root: string, full: string): boolean {
  const base = resolve(root);
  const target = resolve(full);
  return target === base || target.startsWith(base + sep);
}

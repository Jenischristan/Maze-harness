import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/**
 * Resolve `rel` against `root` and guarantee the result cannot escape the
 * workspace, including through symlinks.
 *
 * The lexical check alone is not enough: a symlink inside the workspace that
 * points outside it (`ws/link -> /etc`) passes a pure string-prefix test and
 * lets read/write/edit touch arbitrary files. We therefore compare the real
 * path of the deepest *existing* ancestor against the real path of the root.
 * Components that do not exist yet are resolved lexically from that real
 * ancestor, so `write` can still create new directories inside the workspace.
 */
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

/**
 * realpath the deepest existing ancestor of `full`, then re-append the
 * non-existent tail lexically. This catches a symlink anywhere on the path
 * while still allowing creation of new files/directories.
 */
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

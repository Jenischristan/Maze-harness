import { git } from "./git.js";

export interface DiffOptions {
  /** Repo / workspace directory to diff in. */
  cwd: string;
  /** Diff against this ref instead of the working tree vs HEAD. */
  ref?: string;
  /** Restrict to a path. */
  path?: string;
  /** Include staged changes (default true) and unstaged (default true). */
  staged?: boolean;
  unstaged?: boolean;
  /** Cap the number of lines returned. */
  maxLines?: number;
}

export interface DiffResult {
  /** Unified diff text (empty when there are no changes). */
  patch: string;
  files: Array<{ path: string; added: number; removed: number }>;
  added: number;
  removed: number;
  /** True when the output was cut at `maxLines`. */
  truncated: boolean;
  /** Why the diff is empty: clean tree, not a repo, or an error. */
  note?: string;
}

/**
 * Produce a unified diff of the workspace and a per-file summary.
 *
 * Three modes, in order of precedence:
 *   - `ref` set:      `git diff <ref>` (everything since that commit)
 *   - staged/unstaged: `git diff HEAD` covers both for a normal tree
 *   - unborn HEAD:    `git diff` against the empty tree so a fresh repo still
 *                     shows its files instead of failing with "unknown revision"
 */
export async function diffWorkspace(opts: DiffOptions): Promise<DiffResult> {
  const { cwd } = opts;
  const inside = await git(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return {
      patch: "",
      files: [],
      added: 0,
      removed: 0,
      truncated: false,
      note: "not a git repository"
    };
  }

  const hasHead = (await git(["rev-parse", "--verify", "HEAD"], cwd)).code === 0;
  const args: string[] = ["-c", "color.ui=false", "diff", "--no-color", "--no-ext-diff"];
  if (opts.ref) {
    args.push(opts.ref);
  } else if (hasHead) {
    args.push("HEAD");
  } else {
    // Unborn branch: diff the index/working tree against the empty tree.
    const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    args.push(emptyTree);
  }
  if (opts.path) args.push("--", opts.path);

  const res = await git(args, cwd);
  if (res.code !== 0) {
    return {
      patch: "",
      files: [],
      added: 0,
      removed: 0,
      truncated: false,
      note: res.stderr.trim() || `git diff failed (exit ${res.code})`
    };
  }
  const raw = res.stdout;
  if (!raw.trim()) {
    return { patch: "", files: [], added: 0, removed: 0, truncated: false, note: "no changes" };
  }

  const maxLines = opts.maxLines ?? 400;
  const allLines = raw.split("\n");
  const truncated = allLines.length > maxLines;
  const patch = (truncated ? allLines.slice(0, maxLines) : allLines).join("\n");

  const files: Array<{ path: string; added: number; removed: number }> = [];
  let current: { path: string; added: number; removed: number } | null = null;
  let added = 0;
  let removed = 0;
  for (const line of allLines) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { path: m?.[2] ?? line.slice(11), added: 0, removed: 0 };
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      added += 1;
      if (current) current.added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
      if (current) current.removed += 1;
    }
  }
  if (current) files.push(current);
  return { patch, files, added, removed, truncated };
}

/** One-line-per-file summary used by `report`/`diff` output. */
export function diffSummaryLines(result: DiffResult, max = 12): string[] {
  if (result.note && result.files.length === 0) return [result.note];
  const lines = result.files
    .slice(0, max)
    .map(
      (f) =>
        `  ${f.path}  ${f.added > 0 ? `+${f.added}` : "+0"} ${f.removed > 0 ? `-${f.removed}` : "-0"}`
    );
  if (result.files.length > max) lines.push(`  … ${result.files.length - max} more files`);
  lines.push(`  total +${result.added} -${result.removed}`);
  if (result.truncated) lines.push("  (patch truncated; run `git diff` for the rest)");
  return lines;
}

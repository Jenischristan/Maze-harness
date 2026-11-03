import { git } from "./git.js";

export interface DiffOptions {
  cwd: string;

  ref?: string;

  path?: string;

  staged?: boolean;
  unstaged?: boolean;

  maxLines?: number;
}

export interface DiffResult {
  patch: string;
  files: Array<{ path: string; added: number; removed: number }>;
  added: number;
  removed: number;

  truncated: boolean;

  note?: string;
}

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
  // `git diff` ignores untracked files. For the default (whole-workspace, not
  // against an explicit ref) view, include them as synthetic patches so a file
  // an agent just created is visible instead of reported as "no changes".
  const untrackedPatch =
    opts.ref || opts.path ? "" : await untrackedFilesPatch(cwd);
  const raw = [res.stdout, untrackedPatch].filter((s) => s.trim()).join("\n");
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

async function untrackedFilesPatch(cwd: string): Promise<string> {
  const list = await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  if (list.code !== 0) return "";
  const names = list.stdout.split("\u0000").filter((n) => n.length > 0);
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const parts: string[] = [];
  for (const name of names) {
    let content: string;
    try {
      const buf = await readFile(join(cwd, name));
      // Binary files cannot be represented as a text patch.
      if (buf.includes(0)) continue;
      content = buf.toString("utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    parts.push(
      [
        `diff --git a/${name} b/${name}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${name}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`)
      ].join("\n")
    );
  }
  return parts.length > 0 ? `${parts.join("\n")}\n` : "";
}

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

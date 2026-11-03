import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitWorkspace, git, gitOrThrow } from "../src/workspace/git.js";
import { diffWorkspace, diffSummaryLines } from "../src/workspace/diff.js";

const run = promisify(execFile);

let tmp = "";
let initDir = "";
let dir = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dh-git-"));
  dir = tmp;
  initDir = join(tmp, "init");
  await mkdir(initDir, { recursive: true });
  await writeFile(join(initDir, "program.json"), '{"value":0}\n');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function workspace(): GitWorkspace {
  const repo = join(tmp, "repo");
  return new GitWorkspace({
    repoDir: repo,
    worktreesDir: join(repo, "worktrees"),
    initProgramDir: initDir
  });
}

describe("git workspace", () => {
  it("initializes a root commit and tag", async () => {
    const ws = workspace();
    await ws.init();
    const ref = await ws.rootSnapshotRef();
    expect(ref).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is idempotent across repeated inits on a reused repo", async () => {
    const ws = workspace();
    await ws.init();
    const first = await ws.rootSnapshotRef();

    const again = workspace();
    await again.init();
    expect(await again.rootSnapshotRef()).toBe(first);
  });

  it("creates, commits, and removes worktrees", async () => {
    const ws = workspace();
    await ws.init();
    const dir = await ws.createWorktree("w1", await ws.rootSnapshotRef());
    expect(existsSync(join(dir, "program.json"))).toBe(true);
    await writeFile(join(dir, "program.json"), '{"value":5}\n');
    const commit = await ws.commitWorkspace(dir, "node 1");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    await ws.removeWorktree(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("re-creates a worktree with the same name after cleanup", async () => {
    const ws = workspace();
    await ws.init();
    const ref = await ws.rootSnapshotRef();
    const a = await ws.createWorktree("same", ref);
    await ws.removeWorktree(a);
    const b = await ws.createWorktree("same", ref);
    expect(existsSync(b)).toBe(true);
    await ws.removeWorktree(b);
  });

  it("prunes all worktrees", async () => {
    const ws = workspace();
    await ws.init();
    const ref = await ws.rootSnapshotRef();
    const d1 = await ws.createWorktree("p1", ref);
    const d2 = await ws.createWorktree("p2", ref);
    await ws.pruneWorktrees();
    expect(existsSync(d1)).toBe(false);
    expect(existsSync(d2)).toBe(false);
  });

  it("isolates changes between worktrees", async () => {
    const ws = workspace();
    await ws.init();
    const ref = await ws.rootSnapshotRef();
    const a = await ws.createWorktree("a", ref);
    const b = await ws.createWorktree("b", ref);
    await writeFile(join(a, "only-a.txt"), "a");
    expect(existsSync(join(b, "only-a.txt"))).toBe(false);
    await ws.pruneWorktrees();
  });

  it("reports git errors instead of throwing on missing refs", async () => {
    const ws = workspace();
    await ws.init();
    const res = await git(["rev-parse", "--verify", "nope"], ws.repoDir);
    expect(res.code).not.toBe(0);
  });
});

describe("workspace/git", () => {
  it("gitOrThrow surfaces a failing command", async () => {
    await expect(gitOrThrow(["rev-parse", "--verify", "nope"], dir)).rejects.toThrow(/failed/);
  });

  it("requires an init program directory", async () => {
    const ws = new GitWorkspace({
      repoDir: join(dir, "repo"),
      worktreesDir: join(dir, "wt"),
      initProgramDir: join(dir, "missing")
    });
    await mkdir(join(dir, "repo"), { recursive: true });
    await expect(ws.init()).rejects.toThrow(/does not exist/);
  });

  it("bootstraps from a directory, tags root and is idempotent", async () => {
    const seed = join(dir, "seed");
    await mkdir(seed, { recursive: true });
    await writeFile(join(seed, "main.ts"), "console.log(1)\n");
    const ws = new GitWorkspace({
      repoDir: join(dir, "repo"),
      worktreesDir: join(dir, "wt"),
      initProgramDir: seed
    });
    await mkdir(join(dir, "repo"), { recursive: true });
    await ws.init();
    expect(existsSync(join(dir, "repo", ".git"))).toBe(true);
    const first = await ws.rootSnapshotRef();
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    await ws.init();
    expect(await ws.rootSnapshotRef()).toBe(first);
    expect(existsSync(join(dir, "wt"))).toBe(true);
    const { stdout } = await run("git", ["tag", "--list"], { cwd: join(dir, "repo") });
    expect(stdout.trim()).toBe("root");
  });

  it("creates an empty root commit when the seed produces no changes", async () => {
    const seed = join(dir, "seed");
    await mkdir(seed, { recursive: true });
    const repoDir = join(dir, "repo");
    await mkdir(repoDir, { recursive: true });
    const ws = new GitWorkspace({ repoDir, worktreesDir: join(dir, "wt"), initProgramDir: seed });
    await run("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    await run("git", ["config", "user.email", "t@t"], { cwd: repoDir });
    await run("git", ["config", "user.name", "t"], { cwd: repoDir });
    await run("git", ["commit", "-q", "--allow-empty", "-m", "seed"], { cwd: repoDir });
    await ws.init();
    expect(await ws.rootSnapshotRef()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("seeds a single file source", async () => {
    const src = join(dir, "one.ts");
    await writeFile(src, "export const a = 1;\n");
    const repoDir = join(dir, "repo");
    await mkdir(repoDir, { recursive: true });
    const ws = new GitWorkspace({ repoDir, worktreesDir: join(dir, "wt"), initProgramDir: src });
    await ws.init();
    expect(existsSync(join(repoDir, "one.ts"))).toBe(true);
  });

  it("rejects an unset init program", async () => {
    const ws = new GitWorkspace({
      repoDir: join(dir, "repo"),
      worktreesDir: join(dir, "wt"),
      initProgramDir: undefined as unknown as string
    });
    await mkdir(join(dir, "repo"), { recursive: true });
    await expect(ws.init()).rejects.toThrow(/not set/);
  });
});

describe("workspace/diff", () => {
  async function initRepo(): Promise<string> {
    const repo = join(dir, "repo");
    await mkdir(repo, { recursive: true });
    await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    await run("git", ["config", "user.email", "t@t"], { cwd: repo });
    await run("git", ["config", "user.name", "t"], { cwd: repo });
    return repo;
  }

  it("reports a non-repository directory", async () => {
    const res = await diffWorkspace({ cwd: dir });
    expect(res.note).toBe("not a git repository");
    expect(diffSummaryLines(res)).toEqual(["not a git repository"]);
  });

  it("reports no changes for a clean repository", async () => {
    const repo = await initRepo();
    await writeFile(join(repo, "a.txt"), "one\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "one"], { cwd: repo });
    const res = await diffWorkspace({ cwd: repo });
    expect(res.note).toBe("no changes");
    expect(diffSummaryLines(res)).toEqual(["no changes"]);
  });

  it("counts an untracked file as a synthetic patch", async () => {
    const repo = await initRepo();
    await writeFile(join(repo, "new.txt"), "a\nb\n");
    const res = await diffWorkspace({ cwd: repo });
    expect(res.files.map((f) => f.path)).toContain("new.txt");
    expect(res.patch).toContain("new file mode");
    expect(res.added).toBeGreaterThan(0);
  });

  it("diffs a working tree against HEAD including modifications", async () => {
    const repo = await initRepo();
    await writeFile(join(repo, "a.txt"), "one\ntwo\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "one"], { cwd: repo });
    await writeFile(join(repo, "a.txt"), "one\nthree\n");
    const res = await diffWorkspace({ cwd: repo });
    expect(res.files[0]).toMatchObject({ path: "a.txt", added: 1, removed: 1 });
    expect(diffSummaryLines(res).join("\n")).toContain("a.txt");
  });

  it("diffs against an explicit ref and ignores untracked files there", async () => {
    const repo = await initRepo();
    await writeFile(join(repo, "a.txt"), "one\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "one"], { cwd: repo });
    await run("git", ["tag", "base"], { cwd: repo });
    await writeFile(join(repo, "a.txt"), "two\n");
    const res = await diffWorkspace({ cwd: repo, ref: "base" });
    expect(res.files).toHaveLength(1);
    await writeFile(join(repo, "u.txt"), "x");
    expect((await diffWorkspace({ cwd: repo, ref: "base" })).files.map((f) => f.path)).toEqual([
      "a.txt"
    ]);
  });

  it("restricts the diff to a path", async () => {
    const repo = await initRepo();
    await writeFile(join(repo, "a.txt"), "one\n");
    await writeFile(join(repo, "b.txt"), "one\n");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-q", "-m", "one"], { cwd: repo });
    await writeFile(join(repo, "a.txt"), "two\n");
    await writeFile(join(repo, "b.txt"), "two\n");
    const res = await diffWorkspace({ cwd: repo, path: "a.txt" });
    expect(res.files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  it("reports a git failure instead of throwing", async () => {
    const repo = await initRepo();
    const res = await diffWorkspace({ cwd: repo, ref: "does-not-exist" });
    expect(res.files).toEqual([]);
    expect(res.note).toBeTruthy();
    expect(diffSummaryLines(res)).toEqual([res.note]);
  });

  it("handles a repository with no commits via the empty tree", async () => {
    const repo = await initRepo();
    await writeFile(join(repo, "a.txt"), "x\n");
    await run("git", ["add", "-A"], { cwd: repo });
    const res = await diffWorkspace({ cwd: repo });
    expect(res.files.map((f) => f.path)).toContain("a.txt");
  });

  it("truncates a large patch and flags it", async () => {
    const repo = await initRepo();
    await writeFile(join(repo, "big.txt"), "line\n".repeat(50_000));
    await run("git", ["add", "-A"], { cwd: repo });
    const res = await diffWorkspace({ cwd: repo, maxLines: 5 });
    expect(res.truncated).toBe(true);
    expect(diffSummaryLines(res).join("\n")).toContain("patch truncated");
  });

  it("summarises more files than the display limit", () => {
    const res = {
      patch: "",
      files: Array.from({ length: 15 }, (_, i) => ({ path: `f${i}`, added: 1, removed: 0 })),
      added: 15,
      removed: 0,
      truncated: false,
      note: ""
    };
    const lines = diffSummaryLines(res as never, 10);
    expect(lines.join("\n")).toContain("5 more files");
    expect(lines.join("\n")).toContain("total +15 -0");
  });
});

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorkspace, git } from "../src/workspace/git.js";

let tmp = "";
let initDir = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dh-git-"));
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
    // A second workspace over the same repo must not fail on "nothing to commit".
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

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorkspace, git } from "../src/workspace/git.js";
import { TurnSnapshots, removeDir } from "../src/workspace/snapshot.js";
import {
  materializeWorkspace,
  workspaceSourceMatches
} from "../src/workspace/materialize.js";

let tmp = "";
let initDir = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "dh-wsx-"));
  initDir = join(tmp, "init");
  await mkdir(initDir, { recursive: true });
  await writeFile(join(initDir, "program.json"), '{"value":0}\n');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function workspace(): GitWorkspace {
  return new GitWorkspace({
    repoDir: join(tmp, "repo"),
    worktreesDir: join(tmp, "repo", "worktrees"),
    initProgramDir: initDir
  });
}

describe("turn snapshots", () => {
  async function snapshots(): Promise<{ ws: GitWorkspace; snaps: TurnSnapshots }> {
    const ws = workspace();
    await ws.init();
    const snaps = new TurnSnapshots(
      { commitWorkspace: (dir, msg) => ws.commitWorkspace(dir, msg) },
      ws.repoDir
    );
    return { ws, snaps };
  }

  it("snapshots state and restores it after later edits", async () => {
    const { ws, snaps } = await snapshots();
    await writeFile(join(ws.repoDir, "a.txt"), "v1\n");
    await snaps.snapshot("first");
    expect(snaps.currentRef).toMatch(/^refs\/dream\/turns\/1$/);

    await writeFile(join(ws.repoDir, "a.txt"), "v2\n");
    await writeFile(join(ws.repoDir, "untracked.txt"), "junk\n");
    await snaps.restore();

    expect(await readFile(join(ws.repoDir, "a.txt"), "utf8")).toBe("v1\n");
    expect(existsSync(join(ws.repoDir, "untracked.txt"))).toBe(false);
  });

  it("the returned undo closure rolls the turn back", async () => {
    const { ws, snaps } = await snapshots();
    await writeFile(join(ws.repoDir, "a.txt"), "before\n");
    const undo = await snaps.snapshot("turn");
    await writeFile(join(ws.repoDir, "a.txt"), "after\n");
    await undo();
    expect(await readFile(join(ws.repoDir, "a.txt"), "utf8")).toBe("before\n");
  });

  it("undoLast restores the newest snapshot and pops the stack", async () => {
    const { ws, snaps } = await snapshots();
    await writeFile(join(ws.repoDir, "a.txt"), "one\n");
    await snaps.snapshot("one");
    await writeFile(join(ws.repoDir, "a.txt"), "two\n");
    await snaps.snapshot("two");
    await writeFile(join(ws.repoDir, "a.txt"), "three\n");

    await snaps.undoLast();
    expect(await readFile(join(ws.repoDir, "a.txt"), "utf8")).toBe("two\n");
    await snaps.undoLast();
    expect(await readFile(join(ws.repoDir, "a.txt"), "utf8")).toBe("one\n");
    expect(snaps.currentRef).toBeNull();
    await expect(snaps.undoLast()).rejects.toThrow(/no snapshot/);
  });

  it("prune deletes every turn ref and clears state", async () => {
    const { ws, snaps } = await snapshots();
    await writeFile(join(ws.repoDir, "a.txt"), "x\n");
    await snaps.snapshot("a");
    await snaps.snapshot("b");
    await snaps.prune();
    expect(snaps.currentRef).toBeNull();
    const refs = await git(["for-each-ref", "--format=%(refname)", "refs/dream/turns/"], ws.repoDir);
    expect(refs.stdout.trim()).toBe("");
    await expect(snaps.restore("refs/dream/turns/1")).rejects.toThrow(/not found/);
  });

  it("restore with no ref at all fails loudly", async () => {
    const { snaps } = await snapshots();
    await expect(snaps.restore()).rejects.toThrow(/no snapshot to restore/);
  });

  it("removeDir tolerates a missing directory", async () => {
    await expect(removeDir(join(tmp, "nope"))).resolves.toBeUndefined();
    await mkdir(join(tmp, "adir"), { recursive: true });
    await writeFile(join(tmp, "adir", "f"), "x");
    await removeDir(join(tmp, "adir"));
    expect(existsSync(join(tmp, "adir"))).toBe(false);
  });
});

describe("materializeWorkspace", () => {
  async function sourceRepo(): Promise<string> {
    const root = join(tmp, "src-root");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "test"), { recursive: true });
    await mkdir(join(root, "agents"), { recursive: true });
    await mkdir(join(root, "prompts"), { recursive: true });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await writeFile(join(root, "src", "cli.ts"), "export const x = 1;\n");
    await writeFile(join(root, "src", "extra.ts"), "export const y = 2;\n");
    await writeFile(join(root, "test", "a.test.ts"), "// test\n");
    await writeFile(join(root, "agents", "a.mjs"), "// agent\n");
    await writeFile(join(root, "prompts", "p.md"), "# prompt\n");
    await writeFile(join(root, "package.json"), '{"name":"x"}\n');
    await writeFile(join(root, "README.md"), "# readme\n");
    await writeFile(join(root, "node_modules", "junk.js"), "junk\n");
    await writeFile(join(root, "dist.js"), "ignored\n");
    return root;
  }

  it("copies the source files and skips generated directories", async () => {
    const root = await sourceRepo();
    const target = join(tmp, "target");
    const out = await materializeWorkspace({ root, target });
    expect(out).toBe(target);
    expect(await readFile(join(target, "src", "cli.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(await readFile(join(target, "src", "extra.ts"), "utf8")).toBe("export const y = 2;\n");
    expect(await readFile(join(target, "test", "a.test.ts"), "utf8")).toBe("// test\n");
    expect(await readFile(join(target, "agents", "a.mjs"), "utf8")).toBe("// agent\n");
    expect(await readFile(join(target, "prompts", "p.md"), "utf8")).toBe("# prompt\n");
    expect(await readFile(join(target, "package.json"), "utf8")).toBe('{"name":"x"}\n');
    expect(existsSync(join(target, "node_modules"))).toBe(false);
    expect(existsSync(join(target, "dist.js"))).toBe(false);
  });

  it("replaces an existing target unless force is false", async () => {
    const root = await sourceRepo();
    const target = join(tmp, "target");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "stale.txt"), "old\n");

    await materializeWorkspace({ root, target, force: false });
    expect(existsSync(join(target, "stale.txt"))).toBe(true);

    await materializeWorkspace({ root, target });
    expect(existsSync(join(target, "stale.txt"))).toBe(false);
    expect(existsSync(join(target, "src", "cli.ts"))).toBe(true);
  });

  it("workspaceSourceMatches compares only the entrypoint", async () => {
    const root = await sourceRepo();
    const target = join(tmp, "target");
    await materializeWorkspace({ root, target });
    expect(await workspaceSourceMatches(root, target)).toBe(true);

    await writeFile(join(target, "src", "cli.ts"), "export const x = 999;\n");
    expect(await workspaceSourceMatches(root, target)).toBe(false);

    const empty = join(tmp, "empty");
    await mkdir(empty, { recursive: true });
    expect(await workspaceSourceMatches(root, empty)).toBe(false);
  });
});

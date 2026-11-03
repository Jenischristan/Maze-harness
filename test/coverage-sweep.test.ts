import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPermissionPolicy, ttyApproval } from "../src/tools/approval.js";
import { loadVariantSource, seedPolicySource } from "../src/policies/seed.js";
import {
  CURRENT_SCHEMA,
  SchemaVersionError,
  hasFullMigrationChain,
  migrate,
  registerUpcaster,
  stampSchema
} from "../src/util/schema.js";
import { GitWorkspace, gitOrThrow } from "../src/workspace/git.js";
import { diffWorkspace, diffSummaryLines } from "../src/workspace/diff.js";

const run = promisify(execFile);

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-sweep-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tools/approval", () => {
  it("maps permission modes to the default action", () => {
    expect(buildPermissionPolicy(undefined).defaultAction).toBe("allow");
    expect(buildPermissionPolicy("bogus").defaultAction).toBe("allow");
    expect(buildPermissionPolicy("ask").defaultAction).toBe("ask");
    expect(buildPermissionPolicy("deny").defaultAction).toBe("deny");
  });

  it("installs the supplied approver as the ask handler", async () => {
    let asked = 0;
    const policy = buildPermissionPolicy("ask", async () => {
      asked += 1;
      return true;
    });
    await expect(policy.ask!({ tool: "bash", pattern: "ls", args: {} })).resolves.toBe(true);
    expect(asked).toBe(1);
  });

  it("denies without a TTY instead of hanging", async () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(ttyApproval({ tool: "bash", pattern: "rm", args: {} })).resolves.toBe(false);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
    }
  });
});

describe("policies/seed", () => {
  it("loads the fixed variant source", async () => {
    const src = await loadVariantSource("fixed");
    expect(src.policyId).toBe("fixed");
    expect(src.source).toContain("class");
  });

  it("loads the greedy variant with a custom policy id", async () => {
    const src = await loadVariantSource("greedy", "greedy-7");
    expect(src.policyId).toBe("greedy-7");
    expect(src.source.length).toBeGreaterThan(0);
  });

  it("seeds greedy when the policy id starts with greedy, else fixed", async () => {
    expect((await seedPolicySource("greedy-1")).source).toBe(
      (await loadVariantSource("greedy")).source
    );
    expect((await seedPolicySource("other")).source).toBe(
      (await loadVariantSource("fixed")).source
    );
    expect((await seedPolicySource()).policyId).toBe("fixed");
  });
});

describe("util/schema", () => {
  it("stamps the current schema", () => {
    expect(stampSchema({ a: 1 })).toEqual({ a: 1, schema: CURRENT_SCHEMA });
  });

  it("rejects non-objects and invalid versions", () => {
    expect(() => migrate("k", null as never)).toThrow(SchemaVersionError);
    expect(() => migrate("k", { schema: 0 })).toThrow(/invalid schema version/);
    expect(() => migrate("k", { schema: 1.5 })).toThrow(/invalid schema version/);
  });

  it("rejects a record from a newer build", () => {
    expect(() => migrate("k", { schema: CURRENT_SCHEMA + 1 }, CURRENT_SCHEMA)).toThrow(/upgrade/);
  });

  it("stamps the target when there is no chain to walk", () => {
    expect(migrate("plain", { a: 1 }, CURRENT_SCHEMA).schema).toBe(CURRENT_SCHEMA);
  });

  it("fails loudly when a legacy-shaped record has no upcaster", () => {
    expect(() => migrate("live-manifest", { version: 1 }, CURRENT_SCHEMA)).toThrow(/no migration/);
  });

  it("walks a registered upcaster chain", () => {
    registerUpcaster("chain-test", 1, (r) => ({ ...r, one: true }));
    registerUpcaster("chain-test", 2, (r) => ({ ...r, two: true }));
    const out = migrate("chain-test", { schema: 1 }, 3);
    expect(out.schema).toBe(3);
    expect(out).toMatchObject({ one: true, two: true });
    expect(hasFullMigrationChain("chain-test")).toBe(true);
    expect(hasFullMigrationChain("nope")).toBe(false);
  });

  it("rejects an upcaster that returns no record", () => {
    registerUpcaster("bad-upcast", 1, () => null as never);
    expect(() => migrate("bad-upcast", { schema: 1 }, 2)).toThrow(/returned no record/);
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

import { spawn } from "node:child_process";
import { collectText } from "../util/stream.js";
import { taskChildEnv } from "../util/env.js";
import { mkdir, rm, cp, appendFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      // git hooks and credential helpers run inside the workspace repo, so
      // they must not see provider keys. PATH/HOME are enough for git itself.
      env: taskChildEnv(process.env, {
        GIT_AUTHOR_NAME: "maze-harness",
        GIT_AUTHOR_EMAIL: "harness@localhost",
        GIT_COMMITTER_NAME: "maze-harness",
        GIT_COMMITTER_EMAIL: "harness@localhost",
        GIT_TERMINAL_PROMPT: "0"
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    // Every external call needs a deadline: a hung `git` (network fs, hooks,
    // credential prompt) previously blocked the run forever. Cap buffered
    // output too so a runaway command cannot exhaust memory.
    const MAX_BYTES = 4 * 1024 * 1024;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);
    // StringDecoder-backed: commit messages, diffs and filenames can carry
    // non-ASCII text and a chunk boundary must not corrupt it with U+FFFD.
    const outSink = collectText(child.stdout, { cap: MAX_BYTES });
    const errSink = collectText(child.stderr, { cap: MAX_BYTES });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = outSink.flush();
      let stderr = errSink.flush();
      if (timedOut) {
        stderr += "\n[git timed out after 120000ms]";
        resolvePromise({ code: -1, stdout, stderr });
        return;
      }
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function gitOrThrow(args: string[], cwd: string): Promise<GitResult> {
  const res = await git(args, cwd);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
  }
  return res;
}

/**
 * Copy a seed path into the repo working tree. `src` may be a directory (copy
 * its contents recursively) or a single file (copy into the repo root under
 * its own name). Previously the file case was passed straight to `cp(src,
 * repoDir)`, which copied the file *over* the directory path and failed.
 */
async function seedRepo(src: string | undefined, repoDir: string): Promise<void> {
  if (!src) {
    throw new Error("initProgramDir is not set; cannot bootstrap the workspace");
  }
  const info = await stat(src).catch(() => null);
  if (!info) {
    throw new Error(`initProgramDir does not exist: ${src}`);
  }
  if (info.isDirectory()) {
    await cp(src, repoDir, { recursive: true, force: true });
    return;
  }
  // Copy the file into the repo root under its own name.
  await cp(src, join(repoDir, basename(src)));
}

export class GitWorkspace {
  readonly repoDir: string;
  readonly worktreesDir: string;
  private readonly initProgramDir: string;

  constructor(opts: { repoDir: string; worktreesDir: string; initProgramDir: string }) {
    this.repoDir = opts.repoDir;
    this.worktreesDir = opts.worktreesDir;
    this.initProgramDir = opts.initProgramDir;
  }

  async init(): Promise<void> {
    await mkdir(this.worktreesDir, { recursive: true });
    if (!existsSync(join(this.repoDir, ".git"))) {
      await gitOrThrow(["init", "-q", "-b", "main"], this.repoDir);
    }
    const infoDir = join(this.repoDir, ".git", "info");
    await mkdir(infoDir, { recursive: true });
    await appendFile(join(infoDir, "exclude"), "\nworktrees/\n").catch(() => undefined);
    await gitOrThrow(["config", "user.name", "maze-harness"], this.repoDir);
    await gitOrThrow(["config", "user.email", "harness@localhost"], this.repoDir);
    await this.initRootIfNeeded();
  }

  async initRootIfNeeded(): Promise<void> {
    const existing = await git(["rev-parse", "--verify", "root"], this.repoDir);
    if (existing.code === 0) return;
    // `initProgramPath` points at the initial *program* (a file such as
    // `examples/toy-task/program.json` or a directory of seeds). Copying a file
    // onto `repoDir` used to fail with "src argument must be a string" when the
    // path was undefined and silently created the wrong tree when it was a
    // file. Handle both shapes explicitly and fail loudly when the seed does
    // not exist, instead of bootstrapping a repo from nothing.
    await seedRepo(this.initProgramDir, this.repoDir);
    await gitOrThrow(["add", "-A"], this.repoDir);
    // A reused repo may already have the init files committed (identical tree).
    // There is then nothing to commit and `git commit` exits non-zero, so tag
    // the current HEAD as root instead of failing the run.
    const status = await gitOrThrow(["status", "--porcelain"], this.repoDir);
    if (status.stdout.trim().length > 0) {
      await gitOrThrow(["commit", "-q", "-m", "root: init program"], this.repoDir);
    } else {
      const head = await git(["rev-parse", "--verify", "HEAD"], this.repoDir);
      if (head.code !== 0) {
        await gitOrThrow(
          ["commit", "-q", "--allow-empty", "-m", "root: empty init program"],
          this.repoDir
        );
      }
    }
    await gitOrThrow(["tag", "-f", "root"], this.repoDir);
  }

  async rootSnapshotRef(): Promise<string> {
    const res = await gitOrThrow(["rev-parse", "root"], this.repoDir);
    return res.stdout.trim();
  }

  async createWorktree(name: string, snapshotRef: string | null): Promise<string> {
    const dir = join(this.worktreesDir, name);
    await rm(dir, { recursive: true, force: true });
    const ref = snapshotRef && snapshotRef !== "root" ? snapshotRef : "root";
    // A crashed run can leave the name registered; prune before re-adding.
    await git(["worktree", "prune"], this.repoDir);
    const res = await git(["worktree", "add", "--detach", dir, ref], this.repoDir);
    if (res.code !== 0) {
      await git(["worktree", "prune"], this.repoDir);
      await gitOrThrow(["worktree", "add", "--detach", "-f", dir, ref], this.repoDir);
    }
    return dir;
  }

  async commitWorkspace(worktreeDir: string, message: string): Promise<string> {
    await gitOrThrow(["add", "-A"], worktreeDir);
    const status = await gitOrThrow(["status", "--porcelain"], worktreeDir);
    if (status.stdout.trim().length > 0) {
      await gitOrThrow(["commit", "-q", "-m", message], worktreeDir);
    }
    const head = await gitOrThrow(["rev-parse", "HEAD"], worktreeDir);
    return head.stdout.trim();
  }

  /** Remove every registered worktree (used on abort / cleanup). */
  async pruneWorktrees(): Promise<void> {
    const list = await git(["worktree", "list", "--porcelain"], this.repoDir);
    if (list.code !== 0) return;
    for (const line of list.stdout.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const dir = line.slice("worktree ".length).trim();
      if (dir === this.repoDir) continue;
      await this.removeWorktree(dir);
    }
    await git(["worktree", "prune"], this.repoDir);
  }

  async removeWorktree(worktreeDir: string): Promise<void> {
    const res = await git(["worktree", "remove", "--force", worktreeDir], this.repoDir);
    if (res.code !== 0) {
      await rm(worktreeDir, { recursive: true, force: true });
      await git(["worktree", "prune"], this.repoDir);
    }
  }
}

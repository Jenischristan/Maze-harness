import { spawn } from "node:child_process";
import { mkdir, rm, cp, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "dream-harness",
        GIT_AUTHOR_EMAIL: "harness@localhost",
        GIT_COMMITTER_NAME: "dream-harness",
        GIT_COMMITTER_EMAIL: "harness@localhost"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export async function gitOrThrow(args: string[], cwd: string): Promise<GitResult> {
  const res = await git(args, cwd);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
  }
  return res;
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
    await gitOrThrow(["config", "user.name", "dream-harness"], this.repoDir);
    await gitOrThrow(["config", "user.email", "harness@localhost"], this.repoDir);
    await this.initRootIfNeeded();
  }

  async initRootIfNeeded(): Promise<void> {
    const existing = await git(["rev-parse", "--verify", "root"], this.repoDir);
    if (existing.code === 0) return;
    await cp(this.initProgramDir, this.repoDir, { recursive: true, force: true });
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

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOrThrow, type GitWorkspace } from "./git.js";

/**
 * Per-turn workspace snapshots.
 *
 * The harness applied edits one at a time with no turn boundary: if turn 3 of
 * 5 failed (a tool threw, the process was interrupted, the model went into a
 * loop), the workspace was left half-mutated with no automatic revert. The
 * only recovery was a manual `checkpoint`.
 *
 * `TurnSnapshots` records an anonymous git commit on a private ref before each
 * turn and can restore it. The commits live on `refs/dream/turns/<n>`, never on
 * a branch, so they do not pollute history and can be garbage-collected.
 *
 * Restore is `git reset --hard <ref>` **plus** `git clean -fd` for files the
 * turn created, which `reset` alone does not remove.
 */
export class TurnSnapshots {
  private readonly ws: Pick<GitWorkspace, "commitWorkspace">;
  private readonly dir: string;
  private readonly refPrefix: string;
  private counter = 0;
  private lastRef: string | null = null;
  private readonly stack: string[] = [];

  constructor(ws: Pick<GitWorkspace, "commitWorkspace">, dir: string, refPrefix = "dream/turns") {
    this.ws = ws;
    this.dir = dir;
    this.refPrefix = refPrefix;
  }

  /**
   * Snapshot the current state and return a restore function. The restore
   * function is idempotent and safe to call after the process has moved on.
   */
  async snapshot(label = "turn"): Promise<() => Promise<void>> {
    this.counter += 1;
    const ref = `${this.refPrefix}/${this.counter}`;
    // Commit any worktree changes so the ref points at the exact state.
    const sha = await this.ws
      .commitWorkspace(this.dir, `snapshot ${label} #${this.counter}`)
      .catch(async () => {
        // A clean tree still needs a ref: resolve HEAD instead of failing.
        const head = await gitOrThrow(["rev-parse", "HEAD"], this.dir);
        return head.stdout.trim();
      });
    await gitOrThrow(["update-ref", `refs/${ref}`, sha], this.dir);
    this.lastRef = `refs/${ref}`;
    this.stack.push(this.lastRef);
    return async () => {
      await this.restore(this.lastRef!);
    };
  }

  /** Restore the workspace to a recorded ref (including removing new files). */
  async restore(ref: string = this.lastRef ?? ""): Promise<void> {
    if (!ref) throw new Error("no snapshot to restore");
    const check = await git(["rev-parse", "--verify", ref], this.dir);
    if (check.code !== 0) throw new Error(`snapshot ref not found: ${ref}`);
    await gitOrThrow(["reset", "--hard", ref], this.dir);
    // `reset --hard` leaves untracked files (new files created this turn).
    // Remove them, but never `.git` and never registered worktree dirs.
    await gitOrThrow(["clean", "-fd", "-e", "worktrees/"], this.dir);
  }

  /** Undo the most recent snapshot, restoring the state before it. */
  async undoLast(): Promise<void> {
    // The snapshot commit IS the pre-turn state, so restoring it is the undo.
    if (!this.lastRef) throw new Error("no snapshot recorded");
    await this.restore(this.lastRef);
    this.stack.pop();
    this.lastRef = this.stack.at(-1) ?? null;
  }

  /** Delete every turn ref (cleanup at the end of a run). */
  async prune(): Promise<void> {
    const list = await git(
      ["for-each-ref", "--format=%(refname)", `refs/${this.refPrefix}/`],
      this.dir
    );
    if (list.code !== 0) return;
    for (const ref of list.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)) {
      await git(["update-ref", "-d", ref], this.dir);
    }
    this.stack.length = 0;
    this.lastRef = null;
  }

  get currentRef(): string | null {
    return this.lastRef;
  }
}

/**
 * Remove a directory tree. Kept here so callers do not need to import fs
 * promises just for a snapshot cleanup path.
 */
export async function removeDir(dir: string): Promise<void> {
  await rm(join(dir), { recursive: true, force: true }).catch(() => undefined);
}

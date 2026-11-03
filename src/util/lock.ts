import { open, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * Cross-process run lock.
 *
 * Two `dream` runs pointed at the same `runs/` directory both wrote
 * `reports/_current` and `tNNNN-*.json` manifests, raced on
 * `policies/build/<id>.ts`, and could interleave git worktree names. Nothing
 * detected it; the last writer simply won and the run's history was a mix of
 * two experiments.
 *
 * `RunLock` is an exclusive, PID-stamped lock file:
 *
 *   - acquire: `O_EXCL` create, so exactly one process wins,
 *   - stale detection: a lock whose PID is gone (or whose host differs but is
 *     older than `maxAgeMs`) is reclaimed with a warning,
 *   - release: removes the file only if this process still owns it,
 *   - `heartbeat`: refreshes mtime so a long run is never considered stale.
 */

export interface LockInfo {
  pid: number;
  host: string;
  runId: string;
  acquiredAt: string;
}

export interface RunLockOptions {
  /** Lock file path. */
  path: string;
  /** Identifier recorded in the lock for diagnostics. */
  runId: string;
  /** Treat a lock older than this as stale. Default 6 hours. */
  maxAgeMs?: number;
  /** Called when an existing lock is reclaimed as stale. */
  onReclaim?: (info: LockInfo | null, reason: string) => void;
}

export class LockHeldError extends Error {
  constructor(
    readonly info: LockInfo | null,
    readonly path: string
  ) {
    super(
      info
        ? `run lock held by pid ${info.pid} on ${info.host} (run ${info.runId}, since ${info.acquiredAt})`
        : `run lock held (${path})`
    );
  }
}

export class RunLock {
  private readonly opts: Required<Omit<RunLockOptions, "onReclaim">> & {
    onReclaim?: RunLockOptions["onReclaim"];
  };
  private held = false;

  constructor(opts: RunLockOptions) {
    this.opts = {
      path: opts.path,
      runId: opts.runId,
      maxAgeMs: opts.maxAgeMs ?? 6 * 60 * 60 * 1000,
      onReclaim: opts.onReclaim
    };
  }

  get isHeld(): boolean {
    return this.held;
  }

  async acquire(): Promise<void> {
    const info: LockInfo = {
      pid: process.pid,
      host: hostname(),
      runId: this.opts.runId,
      acquiredAt: new Date().toISOString()
    };
    try {
      await this.createExclusive(info);
      this.held = true;
      return;
    } catch (err) {
      if (!isExists(err)) throw err;
    }
    const existing = await this.readExisting();
    const stale = await this.isStale(existing);
    if (!stale) throw new LockHeldError(existing, this.opts.path);
    this.opts.onReclaim?.(existing, stale);
    // Reclaim: remove and retry once. A lost race here surfaces as LockHeldError.
    await rm(this.opts.path, { force: true });
    try {
      await this.createExclusive(info);
      this.held = true;
    } catch (err) {
      if (isExists(err)) throw new LockHeldError(await this.readExisting(), this.opts.path);
      throw err;
    }
  }

  /** Refresh the lock's mtime so a long-running job is not seen as stale. */
  async heartbeat(): Promise<void> {
    if (!this.held) return;
    const handle = await open(this.opts.path, "r+").catch(() => null);
    if (!handle) return;
    try {
      const now = new Date();
      await handle.utimes(now, now);
    } finally {
      await handle.close();
    }
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    const existing = await this.readExisting();
    // Only remove the lock if it is still ours; another process may have
    // reclaimed a lock we were thought to hold.
    if (existing && existing.pid !== process.pid) return;
    await rm(this.opts.path, { force: true });
  }

  private async createExclusive(info: LockInfo): Promise<void> {
    const handle = await open(this.opts.path, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(info, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  }

  private async readExisting(): Promise<LockInfo | null> {
    try {
      return JSON.parse(await readFile(this.opts.path, "utf8")) as LockInfo;
    } catch {
      return null;
    }
  }

  private async isStale(existing: LockInfo | null): Promise<string | false> {
    const info = await stat(this.opts.path).catch(() => null);
    if (!info) return "lock file vanished";
    const age = Date.now() - info.mtimeMs;
    if (age > this.opts.maxAgeMs) return `lock is ${Math.round(age / 60000)} min old`;
    if (!existing) return "lock file is unreadable";
    if (existing.host !== hostname()) {
      // A remote host's PID is meaningless here; rely on age only.
      return age > 60 * 60 * 1000 ? "lock is on another host and is over an hour old" : false;
    }
    if (!isPidAlive(existing.pid)) return `pid ${existing.pid} is not running`;
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we may not signal it.
    return code === "EPERM";
  }
}

function isExists(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

/** Default lock path for a run root. */
export function runLockPath(runsDir: string): string {
  return join(runsDir, ".dream.lock");
}

/** True when a lock file is currently present (diagnostics only). */
export function lockPresent(runsDir: string): boolean {
  return existsSync(runLockPath(runsDir));
}

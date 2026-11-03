import { open, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export interface LockInfo {
  pid: number;
  host: string;
  runId: string;
  acquiredAt: string;
}

export interface RunLockOptions {
  path: string;

  runId: string;

  maxAgeMs?: number;

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

    await rm(this.opts.path, { force: true });
    try {
      await this.createExclusive(info);
      this.held = true;
    } catch (err) {
      if (isExists(err)) throw new LockHeldError(await this.readExisting(), this.opts.path);
      throw err;
    }
  }

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

    return code === "EPERM";
  }
}

function isExists(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

export function runLockPath(runsDir: string): string {
  return join(runsDir, ".dream.lock");
}

export function lockPresent(runsDir: string): boolean {
  return existsSync(runLockPath(runsDir));
}

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOrThrow, type GitWorkspace } from "./git.js";

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

  async snapshot(label = "turn"): Promise<() => Promise<void>> {
    this.counter += 1;
    const ref = `${this.refPrefix}/${this.counter}`;

    const sha = await this.ws
      .commitWorkspace(this.dir, `snapshot ${label} #${this.counter}`)
      .catch(async () => {
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

  async restore(ref: string = this.lastRef ?? ""): Promise<void> {
    if (!ref) throw new Error("no snapshot to restore");
    const check = await git(["rev-parse", "--verify", ref], this.dir);
    if (check.code !== 0) throw new Error(`snapshot ref not found: ${ref}`);
    await gitOrThrow(["reset", "--hard", ref], this.dir);

    await gitOrThrow(["clean", "-fd", "-e", "worktrees/"], this.dir);
  }

  async undoLast(): Promise<void> {
    if (!this.lastRef) throw new Error("no snapshot recorded");
    await this.restore(this.lastRef);
    this.stack.pop();
    this.lastRef = this.stack.at(-1) ?? null;
  }

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

export async function removeDir(dir: string): Promise<void> {
  await rm(join(dir), { recursive: true, force: true }).catch(() => undefined);
}

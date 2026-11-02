import { spawn } from "node:child_process";
import type { HookRegistry, HookResult, VerifyHook } from "./hookTypes.js";

export type { HookResult, HookRegistry, VerifyHook } from "./hookTypes.js";

export interface RunHooksOptions {
  workspaceDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

async function runOne(hook: VerifyHook, opts: RunHooksOptions): Promise<HookResult> {
  const started = Date.now();
  return new Promise<HookResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(hook.command, [], {
      cwd: opts.workspaceDir,
      shell: true,
      env: { ...process.env, ...(hook.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    const cap = (s: string): string =>
      Buffer.byteLength(s) > opts.maxOutputBytes
        ? `${s.slice(0, opts.maxOutputBytes)}\n[truncated]`
        : s;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, hook.timeoutMs ?? opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (Buffer.byteLength(stdout) < opts.maxOutputBytes) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (Buffer.byteLength(stderr) < opts.maxOutputBytes) stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        name: hook.name,
        ok: false,
        output: `${err.message}\n${stderr}`,
        timedOut: false,
        wallMs: Date.now() - started
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        name: hook.name,
        ok: !timedOut && code === 0,
        output: cap(`${stdout}${stderr}`.trim()),
        timedOut,
        wallMs: Date.now() - started
      });
    });
  });
}

export class Hooks implements HookRegistry {
  private readonly hooks: VerifyHook[] = [];
  private readonly opts: RunHooksOptions;

  constructor(opts: RunHooksOptions) {
    this.opts = opts;
  }

  register(hook: VerifyHook): void {
    this.hooks.push(hook);
  }

  list(): VerifyHook[] {
    return [...this.hooks];
  }

  async runAll(): Promise<HookResult[]> {
    const out: HookResult[] = [];
    for (const hook of this.hooks) out.push(await runOne(hook, this.opts));
    return out;
  }
}

/** Parse `--verify "npm run lint"` style strings into hooks. */
export function verifyCommandsToHooks(commands: string[]): VerifyHook[] {
  return commands
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((command, i) => ({
      name: `verify-${i + 1}`,
      command,
      timeoutMs: 120_000
    }));
}

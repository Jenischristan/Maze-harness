import { spawn } from "node:child_process";
import { collectText } from "../util/stream.js";
import { taskChildEnv } from "../util/env.js";
import { redact } from "../util/redact.js";
import type { HookRegistry, HookResult, VerifyHook } from "./hookTypes.js";

export type { HookResult, VerifyHook } from "./hookTypes.js";

export interface RunHooksOptions {
  workspaceDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

async function runOne(
  hook: VerifyHook,
  opts: RunHooksOptions,
  signal?: AbortSignal
): Promise<HookResult> {
  const started = Date.now();
  return new Promise<HookResult>((resolve) => {
    let timedOut = false;
    let aborted = false;
    if (signal?.aborted) {
      resolve({ name: hook.name, ok: false, output: "aborted", timedOut: false, wallMs: 0 });
      return;
    }
    const child = spawn(hook.command, [], {
      cwd: opts.workspaceDir,
      shell: true,
      env: taskChildEnv(process.env, hook.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    const kill = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const cap = (s: string): string => {
      const text = redact(s);
      if (Buffer.byteLength(text) <= opts.maxOutputBytes) return text;
      return `${text.slice(0, opts.maxOutputBytes)}\n[truncated]`;
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, hook.timeoutMs ?? opts.timeoutMs);

    const outSink = collectText(child.stdout, { cap: opts.maxOutputBytes + 1 });
    const errSink = collectText(child.stderr, { cap: opts.maxOutputBytes + 1 });
    const settle = (): void => signal?.removeEventListener("abort", onAbort);
    child.on("error", (err) => {
      clearTimeout(timer);
      settle();
      resolve({
        name: hook.name,
        ok: false,
        output: `${err.message}\n${errSink.flush()}`,
        timedOut: false,
        wallMs: Date.now() - started
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle();
      resolve({
        name: hook.name,
        ok: !timedOut && !aborted && code === 0,
        output: aborted ? "aborted" : cap(`${outSink.flush()}${errSink.flush()}`.trim()),
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

  async runAll(signal?: AbortSignal): Promise<HookResult[]> {
    const out: HookResult[] = [];
    for (const hook of this.hooks) {
      if (signal?.aborted) break;
      out.push(await runOne(hook, this.opts, signal));
    }
    return out;
  }
}

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

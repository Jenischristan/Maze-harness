import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HookRegistry, HookResult, VerifyHook } from "../tools/hookTypes.js";
import { Hooks } from "../tools/hooks.js";

const here = fileURLToPath(new URL(".", import.meta.url));

function script(name: string): string {
  return join(here, "..", "..", "agents", "scripts", name);
}

export function formatHookFeedback(
  results: Array<{ name: string; ok: boolean; output: string; timedOut: boolean }>
): string {
  if (results.length === 0) return "";
  const lines = ["## Verification", ""];
  for (const r of results) {
    lines.push(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.timedOut ? " (timed out)" : ""}`);
    if (!r.ok && r.output.trim().length > 0) {
      lines.push("```");
      lines.push(r.output.slice(0, 4000));
      lines.push("```");
    }
  }
  const failed = results.some((r) => !r.ok);
  if (failed) {
    lines.push("");
    lines.push("Fix the failures before claiming the task is done.");
  }
  return lines.join("\n");
}

export interface DefaultHooksOptions {
  workspaceDir: string;

  timeoutMs?: number;

  maxOutputBytes?: number;
}

export function makeDefaultHooks(
  commands: string[],
  opts: DefaultHooksOptions
): HookRegistry & {
  runAll(signal?: AbortSignal): Promise<HookResult[]>;
} {
  const hooks = new Hooks({
    workspaceDir: opts.workspaceDir,
    timeoutMs: opts.timeoutMs ?? 120_000,
    maxOutputBytes: opts.maxOutputBytes ?? 16 * 1024
  });
  for (const [i, command] of commands.entries()) {
    const hook: VerifyHook = {
      name: `verify-${i + 1}`,
      command,
      timeoutMs: opts.timeoutMs ?? 120_000
    };
    hooks.register(hook);
  }
  return hooks;
}

export async function writeTranscript(dir: string, name: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

import { spawn } from "node:child_process";
import { collectText } from "../util/stream.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveryAgent, TaskSpec } from "../types.js";

export interface CliAgentConfig {
  command: string[];
  promptMode?: "stdin" | "arg";
  timeoutMs?: number;
  transcriptDir?: string;
  env?: Record<string, string>;
}

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  wallMs: number;
}

export async function runCli(opts: {
  command: string[];
  cwd: string;
  prompt: string;
  promptMode: "stdin" | "arg";
  timeoutMs: number;
  env?: Record<string, string>;
  extraArgs?: string[];
}): Promise<CliRunResult> {
  const [cmd, ...baseArgs] = opts.command;
  if (!cmd) throw new Error("agent command is empty");
  const args =
    opts.promptMode === "arg"
      ? [...baseArgs, ...(opts.extraArgs ?? []), opts.prompt]
      : [...baseArgs, ...(opts.extraArgs ?? [])];
  const started = Date.now();
  return new Promise<CliRunResult>((resolve) => {
    let timedOut = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);
    // StringDecoder-backed: agent output routinely contains non-ASCII text and
    // a chunk boundary must not corrupt it with U+FFFD.
    const outSink = collectText(child.stdout);
    const errSink = collectText(child.stderr);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout: outSink.flush(),
        stderr: `${errSink.flush()}${String(err)}`,
        timedOut,
        wallMs: Date.now() - started
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: outSink.flush(),
        stderr: errSink.flush(),
        timedOut,
        wallMs: Date.now() - started
      });
    });
    if (opts.promptMode === "stdin") child.stdin.end(opts.prompt);
    else child.stdin.end();
  });
}

function renderAgentPrompt(task: TaskSpec, context: import("../types.js").AgentContext): string {
  const lines: string[] = [];
  lines.push(task.prompt);
  lines.push("");
  lines.push(`Task: ${task.name}`);
  lines.push(task.description);
  lines.push("");
  lines.push(`Attempt: branch ${context.branch}, attempt ${context.attempt} (node ${context.nodeId})`);
  if (context.ancestorPath.length > 0) {
    lines.push("");
    lines.push("History along this branch (oldest first):");
    for (const obs of context.ancestorPath) {
      lines.push(
        `- ${obs.id}: score=${obs.score ?? "null"} fail=${obs.failClass}${
          obs.error ? ` error=${obs.error}` : ""
        } deltaVsParent=${obs.deltaVsParent ?? "null"}`
      );
    }
    const failures = context.ancestorPath.filter((o) => !o.valid);
    if (failures.length > 0) {
      lines.push("");
      lines.push("Repair the most recent failure if one is present; do not repeat a failed design.");
    }
  }
  lines.push("");
  lines.push("You are working inside a disposable git worktree. Modify the workspace files in place.");
  lines.push("Do not touch anything outside the workspace. Do not attempt to run or modify the evaluator.");
  return lines.join("\n");
}

export class CliAgent implements DiscoveryAgent {
  private readonly cfg: Required<Omit<CliAgentConfig, "env" | "transcriptDir">> & {
    env?: Record<string, string>;
    transcriptDir?: string;
  };

  constructor(cfg: CliAgentConfig) {
    this.cfg = {
      command: cfg.command,
      promptMode: cfg.promptMode ?? "stdin",
      timeoutMs: cfg.timeoutMs ?? 600000,
      env: cfg.env,
      transcriptDir: cfg.transcriptDir
    };
  }

  async run(input: {
    workspaceDir: string;
    task: TaskSpec;
    parent: import("../types.js").DiscoveryNode | null;
    context: import("../types.js").AgentContext;
  }): Promise<{ transcriptPath?: string; tokens?: number }> {
    const prompt = renderAgentPrompt(input.task, input.context);
    const res = await runCli({
      command: this.cfg.command,
      cwd: input.workspaceDir,
      prompt,
      promptMode: this.cfg.promptMode,
      timeoutMs: this.cfg.timeoutMs,
      env: this.cfg.env
    });
    if (res.timedOut) throw new Error(`agent timed out after ${this.cfg.timeoutMs}ms`);
    if (res.code !== 0) {
      throw new Error(`agent exited ${res.code}: ${res.stderr.slice(0, 2000)}`);
    }
    let transcriptPath: string | undefined;
    if (this.cfg.transcriptDir) {
      await mkdir(this.cfg.transcriptDir, { recursive: true });
      transcriptPath = join(this.cfg.transcriptDir, `${input.context.nodeId}.log`);
      await writeFile(
        transcriptPath,
        `# prompt\n${prompt}\n\n# stdout\n${res.stdout}\n\n# stderr\n${res.stderr}\n`,
        "utf8"
      );
    }
    return { transcriptPath };
  }
}

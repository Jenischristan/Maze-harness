import { spawn } from "node:child_process";
import type { ToolDefinition, ToolResult } from "../types.js";
import { decide } from "./permissions.js";
import { truncateOutput } from "./truncate.js";

/**
 * A persistent shell session.
 *
 * Framing contract
 * ----------------
 * Each command is written as:
 *
 *     { <command> ; } 2>&1
 *     printf '\n%s\n' "<TOKEN>"
 *
 * The marker is printed on its own line, preceded and followed by a newline,
 * and the command's stderr is folded into stdout so we never have to reason
 * about two independent streams. Completion is detected by scanning the
 * accumulated stdout for a line that equals the token exactly. That is stable
 * regardless of how the OS chunks the pipe, whether bash echoes the command,
 * and whether trailing shell warnings follow the marker.
 *
 * Because callers are serialized through `queue`, only one command is ever in
 * flight per session, so the first matching line is necessarily ours.
 */
interface ShellSession {
  child: import("node:child_process").ChildProcessWithoutNullStreams;
  stdout: string;
  waiters: Array<() => void>;
  alive: boolean;
  token: string | null;
  /** Serialization chain: commands run strictly one at a time. */
  queue: Promise<unknown>;
}

const sessions = new Map<string, ShellSession>();

function notify(session: ShellSession): void {
  for (const w of session.waiters.splice(0)) w();
}

function sentinelFor(): string {
  return `__DREAM_DONE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}__`;
}

/**
 * Index just past the line equal to `token`, or -1 when not yet present.
 *
 * The marker is printed as "\n<token>\n", so it always starts a line. We scan
 * complete lines, then check the trailing partial line too: the pipe may
 * deliver the marker without its final newline in the same chunk.
 */
function findMarker(buffer: string, token: string): number {
  let from = 0;
  for (;;) {
    const nl = buffer.indexOf("\n", from);
    if (nl === -1) break;
    if (buffer.slice(from, nl).trim() === token) return nl + 1;
    from = nl + 1;
  }
  // Trailing fragment with no newline yet.
  if (from <= buffer.length && buffer.slice(from).trim() === token) return buffer.length;
  return -1;
}

/**
 * Split the accumulated buffer at the marker, returning the command output
 * (everything before the marker line) and the remainder (shell noise after it).
 */
function splitAtMarker(buffer: string, token: string): { output: string; rest: string } {
  const end = findMarker(buffer, token);
  if (end === -1) return { output: buffer, rest: "" };
  // The marker line starts after the preceding newline (or at 0). `end` may
  // point at the end of the buffer when the trailing newline is absent.
  const searchFrom = Math.max(0, end - token.length - 2);
  const markerStart = buffer.lastIndexOf("\n", searchFrom) + 1;
  return { output: buffer.slice(0, markerStart), rest: buffer.slice(end) };
}

function killSession(session: ShellSession, key: string): void {
  session.alive = false;
  if (sessions.get(key) === session) sessions.delete(key);
  session.child.stdout.removeAllListeners("data");
  session.child.stderr.removeAllListeners("data");
  try {
    if (session.child.pid) process.kill(-session.child.pid, "SIGKILL");
    else session.child.kill("SIGKILL");
  } catch {
    try {
      session.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  for (const w of session.waiters.splice(0)) w();
}

export function resetShells(): void {
  for (const [key, s] of sessions) killSession(s, key);
  sessions.clear();
}

function getSession(workspaceDir: string, id: string, shell: string): ShellSession {
  const key = `${workspaceDir}::${id}`;
  const existing = sessions.get(key);
  if (existing && existing.alive) return existing;
  if (existing) killSession(existing, key);

  const child = spawn(shell, [], {
    cwd: workspaceDir,
    env: { ...process.env, PS1: "", PS2: "", PROMPT_COMMAND: "", HISTFILE: "/dev/null" },
    stdio: ["pipe", "pipe", "pipe"],
    // Own process group: a one-shot command's process-group kill must not
    // reach the long-lived session shell.
    detached: true
  });
  const session: ShellSession = {
    child,
    stdout: "",
    waiters: [],
    alive: true,
    token: null,
    queue: Promise.resolve()
  };
  child.stdout.on("data", (d: Buffer) => {
    if (!session.alive) return;
    session.stdout += d.toString();
    notify(session);
  });
  // stderr is normally folded into stdout by the command wrapper; anything
  // that still arrives here is shell startup noise we do not need.
  child.stderr.on("data", (d: Buffer) => {
    if (!session.alive) return;
    session.stdout += d.toString();
    notify(session);
  });
  child.on("close", () => {
    session.alive = false;
    if (sessions.get(key) === session) sessions.delete(key);
    notify(session);
  });
  child.on("error", () => {
    session.alive = false;
    if (sessions.get(key) === session) sessions.delete(key);
    notify(session);
  });
  sessions.set(key, session);
  return session;
}

/**
 * Execute one command on a live shell session.
 *
 * The command runs inside `{ … ; } 2>&1` so stderr is interleaved with stdout
 * in order, then the marker is printed on its own line. Wrapping the command
 * also means a bare `cd` still affects the shell: `{ … ; }` runs in the current
 * shell, not a subshell, so directory and variable changes persist.
 */
function scriptFor(command: string, token: string): string {
  const escaped = command.replace(/'/g, `'\\''`);
  return `\neval '${escaped}' 2>&1\nprintf '\\n%s\\n' '${token}'\n`;
}

async function runPersistent(
  session: ShellSession,
  command: string,
  timeoutMs: number
): Promise<{ output: string; timedOut: boolean }> {
  if (!session.alive) {
    return { output: "shell session is no longer alive", timedOut: false };
  }
  const token = sentinelFor();
  session.token = token;
  session.stdout = "";

  return new Promise<{ output: string; timedOut: boolean }>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (timedOut: boolean): void => {
      if (settled) return;
      // A marker that arrived just as the timer fired wins: the command did
      // complete, so report success rather than a spurious timeout.
      const completed = findMarker(session.stdout, token) !== -1;
      settled = true;
      if (timer) clearTimeout(timer);
      const idx = session.waiters.indexOf(wake);
      if (idx !== -1) session.waiters.splice(idx, 1);
      const { output } = splitAtMarker(session.stdout, token);
      session.token = null;
      session.stdout = "";
      resolve({ output, timedOut: timedOut && !completed });
    };

    const wake = (): void => {
      if (findMarker(session.stdout, token) !== -1) finish(false);
    };

    timer = setTimeout(() => finish(true), timeoutMs);
    if (findMarker(session.stdout, token) !== -1) {
      finish(false);
      return;
    }
    session.waiters.push(wake);

    // One physical line per command. `eval` runs in the current shell (so cd
    // and variable assignments persist) and folding stderr into stdout keeps
    // ordering deterministic. The marker is printed on its own line.
    const script = scriptFor(command, token);
    session.child.stdin.write(script);
  });
}

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a shell command in the workspace root. Uses a persistent shell by default (state carries across calls); pass `persistent: false` for a fresh one-shot shell. Output is truncated to the byte budget (tail kept, since errors are at the end). Respects the permission policy.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      timeoutMs: { type: "number", description: "Per-command timeout (default 120000)." },
      persistent: { type: "boolean", description: "Reuse the persistent shell (default true)." },
      sessionId: { type: "string", description: "Shell session key (default 'main')." },
      shell: { type: "string", description: "Shell binary (default $SHELL or /bin/bash)." }
    },
    required: ["command"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const command = String(args.command ?? "");
    if (!command.trim()) {
      return { callId: "", name: "bash", ok: false, content: "empty command", error: "empty" };
    }
    const decision = await decide(ctx.permission, "bash", args);
    if (decision.action === "deny") {
      return {
        callId: "",
        name: "bash",
        ok: false,
        content: `permission denied (${decision.reason})`,
        error: "permission-denied"
      };
    }
    const timeoutMs = Math.max(1000, Number(args.timeoutMs ?? 120_000) || 120_000);
    const persistent = args.persistent !== false;
    const sessionId = String(args.sessionId ?? "main");
    const shell = String(args.shell ?? process.env.SHELL ?? "/bin/bash");
    const started = Date.now();

    if (!persistent) {
      return runOneShot(command, ctx.workspaceDir, shell, timeoutMs, started, ctx.maxOutputBytes);
    }

    const key = `${ctx.workspaceDir}::${sessionId}`;
    const seed = getSession(ctx.workspaceDir, sessionId, shell);
    // The session may be killed between calls (timeout, shell exit). Acquire a
    // live one *inside* the queue turn so we never await a dead pipe.
    const run = seed.queue.then(() => {
      const live = getSession(ctx.workspaceDir, sessionId, shell);
      return runPersistent(live, command, timeoutMs).then((r) => ({ r, live }));
    });
    seed.queue = run.catch(() => undefined);
    const { r: result, live } = await run;

    if (result.timedOut) {
      // The command may still be running; kill the session so the next call
      // starts from a clean state instead of inheriting a stalled shell.
      killSession(live, key);
    }

    // Drop shell echoes of the wrapper lines and the marker itself.
    const cleaned = result.output
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        if (t === "") return true;
        if (t.startsWith("printf '\\n%s\\n'")) return false;
        if (t.startsWith("{ ") || t === "} 2>&1") return false;
        if (/cannot set terminal process group|no job control in this shell/.test(t)) return false;
        return true;
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();

    const t = truncateOutput(cleaned, ctx.maxOutputBytes, "tail");
    return {
      callId: "",
      name: "bash",
      ok: !result.timedOut,
      content: result.timedOut ? `[timed out after ${timeoutMs}ms]\n${t.text}` : t.text,
      truncated: t.truncated
        ? { keptBytes: t.keptBytes, droppedBytes: t.droppedBytes, pageToken: t.pageToken }
        : undefined,
      error: result.timedOut ? "timeout" : undefined,
      data: { wallMs: Date.now() - started, persistent: true }
    };
  }
};

function runOneShot(
  command: string,
  cwd: string,
  shell: string,
  timeoutMs: number,
  started: number,
  maxBytes: number
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(shell, ["-lc", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (Buffer.byteLength(stdout) < maxBytes * 2) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (Buffer.byteLength(stderr) < maxBytes * 2) stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ callId: "", name: "bash", ok: false, content: `spawn failed: ${err.message}`, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const t = truncateOutput(`${stdout}${stderr}`, maxBytes, "tail");
      resolve({
        callId: "",
        name: "bash",
        ok: !timedOut && code === 0,
        content: timedOut ? `[timed out after ${timeoutMs}ms]\n${t.text}` : t.text,
        truncated: t.truncated
          ? { keptBytes: t.keptBytes, droppedBytes: t.droppedBytes, pageToken: t.pageToken }
          : undefined,
        error: timedOut ? "timeout" : code !== 0 ? `exit ${code}` : undefined,
        data: { wallMs: Date.now() - started, exitCode: code }
      });
    });
  });
}

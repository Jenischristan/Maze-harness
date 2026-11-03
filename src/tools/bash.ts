import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ToolDefinition, ToolResult } from "../types.js";
import { decide } from "./permissions.js";
import { truncateOutput } from "./truncate.js";
import { collectText } from "../util/stream.js";
import { taskChildEnv } from "../util/env.js";
import { redact } from "../util/redact.js";

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
  /** Holds an incomplete trailing UTF-8 sequence across chunk boundaries. */
  decoder: StringDecoder;
  waiters: Array<() => void>;
  alive: boolean;
  token: string | null;
  /** Directory the session was created in; commands start here. */
  workspaceDir: string;
  /**
   * Set when the shell exits unexpectedly while a command is in flight. The
   * pending `runPersistent` promise settles immediately with this reason
   * instead of waiting out its full timeout.
   */
  exitReason: string | null;
}

const sessions = new Map<string, ShellSession>();
/** Serialization chains keyed by session key, independent of session lifetime. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Wake the single active waiter, if any.
 *
 * Only one command is ever in flight per session (callers are serialized
 * through `queue`), so there is at most one waiter. Draining a list of
 * waiters woke a queued command's waiter from the previous command's output,
 * which then cleared the buffer and made the current command wait out its
 * full timeout.
 */
function notify(session: ShellSession): void {
  const w = session.waiters[0];
  if (w) w();
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
interface MarkerHit {
  /** Offset just past the marker line. */
  end: number;
  /** Exit status encoded in the marker line, or null when absent. */
  status: number | null;
}

/**
 * Find the marker line for `token`.
 *
 * The line is `<token>:<status>`, and it is the last thing a command writes.
 * We scan complete lines and also accept a trailing fragment with no newline
 * yet, because the pipe may split the final `\n` into the next read.
 */
function findMarker(buffer: string, token: string): MarkerHit | null {
  let from = 0;
  for (;;) {
    const nl = buffer.indexOf("\n", from);
    if (nl === -1) break;
    const line = buffer.slice(from, nl).trim();
    if (line.startsWith(token)) {
      return { end: nl + 1, status: parseStatus(line, token) };
    }
    from = nl + 1;
  }
  const tail = buffer.slice(from).trim();
  if (tail.startsWith(token)) {
    return { end: buffer.length, status: parseStatus(tail, token) };
  }
  return null;
}

function parseStatus(line: string, token: string): number | null {
  const rest = line.slice(token.length);
  const m = /^:(\d+)$/.exec(rest);
  return m ? Number(m[1]) : null;
}

/**
 * Split the accumulated buffer at the marker, returning the command output
 * (everything before the marker line) and the remainder (shell noise after it).
 */
function splitAtMarker(
  buffer: string,
  token: string
): { output: string; rest: string; status: number | null } {
  const hit = findMarker(buffer, token);
  if (!hit) return { output: buffer, rest: "", status: null };
  // The marker line starts after the preceding newline (or at 0). `hit.end`
  // may point at the end of the buffer when the trailing newline is absent.
  const searchFrom = Math.max(0, hit.end - token.length - 2);
  const markerStart = buffer.lastIndexOf("\n", searchFrom) + 1;
  return { output: buffer.slice(0, markerStart), rest: buffer.slice(hit.end), status: hit.status };
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
  queues.clear();
}

function getSession(workspaceDir: string, id: string, shell: string): ShellSession {
  const key = `${workspaceDir}::${id}`;
  const existing = sessions.get(key);
  if (existing && existing.alive) return existing;
  // A dead session is removed by its own close/error handler, but a handler
  // that fires after this point must not evict the replacement.
  if (existing) killSession(existing, key);

  const child = spawn(shell, [], {
    cwd: workspaceDir,
    env: taskChildEnv(process.env, {
      PS1: "",
      PS2: "",
      PROMPT_COMMAND: "",
      HISTFILE: "/dev/null"
    }),
    stdio: ["pipe", "pipe", "pipe"],
    // Own process group: a one-shot command's process-group kill must not
    // reach the long-lived session shell.
    detached: true
  });
  const session: ShellSession = {
    child,
    stdout: "",
    decoder: new StringDecoder("utf8"),
    waiters: [],
    alive: true,
    token: null,
    workspaceDir,
    exitReason: null
  };
  // StringDecoder-backed: a chunk boundary in the middle of a multi-byte
  // UTF-8 sequence must not become U+FFFD.
  const decode = (chunk: Buffer): void => {
    if (!session.alive) return;
    const text = session.decoder.write(chunk);
    if (text) {
      session.stdout += text;
      notify(session);
    }
  };
  child.stdout.on("data", decode);
  // stderr is normally folded into stdout by the command wrapper; anything
  // that still arrives here is shell startup noise we do not need.
  child.stderr.on("data", decode);
  const retire = (): void => {
    session.alive = false;
    // Only remove the map entry if it still points at *this* session. A late
    // close/error from an old shell must not evict a freshly created one,
    // which previously left a command running against a detached session.
    if (sessions.get(key) === session) sessions.delete(key);
    // Wake the in-flight command so it fails fast instead of waiting its
    // full timeout (a command that closes stdout or kills the shell).
    session.exitReason = "shell exited unexpectedly";
    notify(session);
  };
  child.on("close", retire);
  child.on("error", retire);
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
/**
 * Build the shell script for one command.
 *
 * Each command runs with its working directory pinned back to the workspace
 * afterwards. `eval` keeps `cd` and variable assignments inside the command
 * itself (a subshell would discard them), but the directory is restored so a
 * stray `cd /tmp` cannot break every later command's relative paths.
 */
function scriptFor(command: string, token: string, workspaceDir: string | undefined): string {
  const escaped = command.replace(/'/g, `'\\''`);
  // Defensive: a session should always carry a workspace, but a stale event
  // from a dead session must never crash a live command with `undefined`.
  const dir = (workspaceDir ?? process.cwd()).replace(/'/g, `'\\''`);
  // `cd --` protects against a workspace starting with `-`. The status is
  // captured *before* restoring cwd, encoded into the marker line, and the
  // marker is the LAST thing written: nothing follows it, so `findMarker`
  // always sees it as a complete line and no trailing shell input can be
  // mistaken for part of the next command.
  return [
    "",
    `eval '${escaped}' 2>&1`,
    "__DREAM_STATUS=$?",
    `cd -- '${dir}' 2>/dev/null || true`,
    `printf '\\n%s:%s\\n' '${token}' "$__DREAM_STATUS"`,
    ""
  ].join("\n");
}

async function runPersistent(
  session: ShellSession,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ output: string; timedOut: boolean; aborted: boolean; exitCode: number | null }> {
  if (!session.alive) {
    return {
      output: "shell session is no longer alive",
      timedOut: false,
      aborted: false,
      exitCode: null
    };
  }
  if (signal?.aborted) {
    return { output: "aborted before execution", timedOut: false, aborted: true, exitCode: null };
  }
  const token = sentinelFor();
  session.token = token;
  session.stdout = "";
  session.exitReason = null;

  return new Promise<{
    output: string;
    timedOut: boolean;
    aborted: boolean;
    exitCode: number | null;
  }>((resolve) => {
    let settled = false;
    let aborted = false;
    // Declared up front because `finish`/`removeWaiter` close over it, then
    // assigned exactly once below the callbacks are defined.
    // eslint-disable-next-line prefer-const
    let timer: NodeJS.Timeout | undefined;

    /**
     * Settle this command. `onlyIfOurs` is false for the timeout path, where
     * we must settle even if no marker arrived.
     *
     * Only *our* token may be consumed. Scanning for any marker and then
     * clearing the buffer could swallow a marker that belongs to the next
     * command (or leave ours for it), which is exactly what produced the
     * intermittent full-timeout stalls.
     */
    const finish = (timedOut: boolean): void => {
      if (settled) return;
      // The shell died mid-command: settle now with a diagnostic rather than
      // blocking until the timeout fires.
      if (!session.alive && findMarker(session.stdout, token) === null) {
        settled = true;
        if (timer) clearTimeout(timer);
        removeWaiter();
        const output = session.stdout;
        session.token = null;
        session.stdout = "";
        resolve({
          output: `${output.trimEnd()}\n[${session.exitReason ?? "shell exited"}]`.trim(),
          timedOut: false,
          aborted: false,
          exitCode: null
        });
        return;
      }
      const hit = findMarker(session.stdout, token);
      if ((timedOut || aborted) && hit === null) {
        settled = true;
        if (timer) clearTimeout(timer);
        removeWaiter();
        // Timed out or aborted: return what we have, drop the token so a late
        // marker can never be mistaken for another command's completion. The
        // caller kills the session, so the buffer is discarded anyway.
        const output = session.stdout;
        session.token = null;
        session.stdout = "";
        resolve({ output: output.trimEnd(), timedOut, aborted, exitCode: null });
        return;
      }
      if (hit === null) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeWaiter();
      const { output, status } = splitAtMarker(session.stdout, token);
      session.token = null;
      session.stdout = "";
      resolve({ output, timedOut: false, aborted: false, exitCode: status });
    };

    const removeWaiter = (): void => {
      const idx = session.waiters.indexOf(wake);
      if (idx !== -1) session.waiters.splice(idx, 1);
      signal?.removeEventListener("abort", onAbort);
    };

    const onAbort = (): void => {
      aborted = true;
      finish(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const wake = (): void => {
      if (findMarker(session.stdout, token) !== null || !session.alive) finish(false);
    };

    timer = setTimeout(() => finish(true), timeoutMs);
    if (findMarker(session.stdout, token) !== null) {
      finish(false);
      return;
    }
    session.waiters.push(wake);

    // One physical line per command. `eval` runs in the current shell (so cd
    // and variable assignments persist) and folding stderr into stdout keeps
    // ordering deterministic. The marker is printed on its own line.
    const script = scriptFor(command, token, session.workspaceDir);
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
      return runOneShot(
        command,
        ctx.workspaceDir,
        shell,
        timeoutMs,
        started,
        ctx.maxOutputBytes,
        ctx.signal
      );
    }

    const key = `${ctx.workspaceDir}::${sessionId}`;
    // The queue is keyed by session key, not by the session object: a killed
    // session may be replaced, and an in-flight command must still complete
    // before the next one starts.
    const prior = queues.get(key) ?? Promise.resolve();
    const run = prior.then(() => {
      const live = getSession(ctx.workspaceDir, sessionId, shell);
      return runPersistent(live, command, timeoutMs, ctx.signal).then((r) => ({ r, live }));
    });
    queues.set(
      key,
      run.catch(() => undefined)
    );
    const { r: result, live } = await run;

    if (result.timedOut || result.aborted) {
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

    // Redact secrets before truncation so a credential split across the cut
    // point is never half-persisted and later reassembled by the model.
    const t = truncateOutput(redact(cleaned), ctx.maxOutputBytes, "tail");
    // A non-zero exit status is a command failure, the same as the one-shot
    // path: report it in `error` so callers and the model can see it, while
    // still returning the output the command produced.
    const exitCode = result.exitCode;
    const failed = !result.timedOut && !result.aborted && exitCode !== null && exitCode !== 0;
    return {
      callId: "",
      name: "bash",
      ok: !result.timedOut && !result.aborted && !failed,
      content: result.aborted
        ? `[aborted]\n${t.text}`
        : result.timedOut
          ? `[timed out after ${timeoutMs}ms]\n${t.text}`
          : t.text,
      truncated: t.truncated
        ? { keptBytes: t.keptBytes, droppedBytes: t.droppedBytes, pageToken: t.pageToken }
        : undefined,
      error: result.aborted
        ? "aborted"
        : result.timedOut
          ? "timeout"
          : failed
            ? `exit ${exitCode}`
            : undefined,
      data: { wallMs: Date.now() - started, persistent: true, exitCode }
    };
  }
};

function runOneShot(
  command: string,
  cwd: string,
  shell: string,
  timeoutMs: number,
  started: number,
  maxBytes: number,
  signal?: AbortSignal
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    let timedOut = false;
    let aborted = signal?.aborted ?? false;
    if (aborted) {
      resolve({
        callId: "",
        name: "bash",
        ok: false,
        content: "aborted before execution",
        error: "aborted"
      });
      return;
    }
    const child = spawn(shell, ["-lc", command], {
      cwd,
      // A model-issued command is untrusted: it must not be able to read
      // provider credentials out of `env`. Keep PATH/HOME/locale only.
      env: taskChildEnv(process.env),
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
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // Collect through StringDecoder so a chunk boundary inside a multi-byte
    // UTF-8 sequence is buffered, not replaced with U+FFFD. The cap bounds
    // retained bytes instead of re-measuring the whole string per chunk.
    const cap = maxBytes * 2;
    const outSink = collectText(child.stdout, { cap });
    const errSink = collectText(child.stderr, { cap });
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        callId: "",
        name: "bash",
        ok: false,
        content: `spawn failed: ${err.message}`,
        error: err.message
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const t = truncateOutput(redact(`${outSink.flush()}${errSink.flush()}`), maxBytes, "tail");
      resolve({
        callId: "",
        name: "bash",
        ok: !timedOut && !aborted && code === 0,
        content: aborted
          ? `[aborted]\n${t.text}`
          : timedOut
            ? `[timed out after ${timeoutMs}ms]\n${t.text}`
            : t.text,
        truncated: t.truncated
          ? { keptBytes: t.keptBytes, droppedBytes: t.droppedBytes, pageToken: t.pageToken }
          : undefined,
        error: aborted ? "aborted" : timedOut ? "timeout" : code !== 0 ? `exit ${code}` : undefined,
        data: { wallMs: Date.now() - started, exitCode: code }
      });
    });
  });
}

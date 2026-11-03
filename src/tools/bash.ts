import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ToolDefinition, ToolResult } from "../types.js";
import { decide } from "./permissions.js";
import { truncateOutput } from "./truncate.js";
import { collectText } from "../util/stream.js";
import { taskChildEnv } from "../util/env.js";
import { redact } from "../util/redact.js";

interface ShellSession {
  child: import("node:child_process").ChildProcessWithoutNullStreams;
  stdout: string;

  decoder: StringDecoder;
  waiters: Array<() => void>;
  alive: boolean;
  token: string | null;

  workspaceDir: string;

  exitReason: string | null;
}

const sessions = new Map<string, ShellSession>();

const queues = new Map<string, Promise<unknown>>();

function notify(session: ShellSession): void {
  const w = session.waiters[0];
  if (w) w();
}

function sentinelFor(): string {
  return `__DREAM_DONE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}__`;
}

interface MarkerHit {
  end: number;

  status: number | null;
}

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

function splitAtMarker(
  buffer: string,
  token: string
): { output: string; rest: string; status: number | null } {
  const hit = findMarker(buffer, token);
  if (!hit) return { output: buffer, rest: "", status: null };

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
      void 0;
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

  const decode = (chunk: Buffer): void => {
    if (!session.alive) return;
    const text = session.decoder.write(chunk);
    if (text) {
      session.stdout += text;
      notify(session);
    }
  };
  child.stdout.on("data", decode);

  child.stderr.on("data", decode);
  const retire = (): void => {
    session.alive = false;

    if (sessions.get(key) === session) sessions.delete(key);

    session.exitReason = "shell exited unexpectedly";
    notify(session);
  };
  child.on("close", retire);
  child.on("error", retire);
  sessions.set(key, session);
  return session;
}

function scriptFor(command: string, token: string, workspaceDir: string | undefined): string {
  const escaped = command.replace(/'/g, `'\\''`);

  const dir = (workspaceDir ?? process.cwd()).replace(/'/g, `'\\''`);

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

    // eslint-disable-next-line prefer-const
    let timer: NodeJS.Timeout | undefined;

    const finish = (timedOut: boolean): void => {
      if (settled) return;

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
      killSession(live, key);
    }

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

    const t = truncateOutput(redact(cleaned), ctx.maxOutputBytes, "tail");

    const exitCode = result.exitCode;
    // A command that terminates the persistent shell (e.g. `exit 7`) has no
    // sentinel, so exitCode is null and alive became false. Reporting that as
    // success used to make failing scripts look like they passed.
    const shellDied = live.exitReason !== null && result.exitCode === null;
    const failed =
      !result.timedOut && !result.aborted && !shellDied && exitCode !== null && exitCode !== 0;
    return {
      callId: "",
      name: "bash",
      ok: !result.timedOut && !result.aborted && !failed && !shellDied,
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
          : shellDied
            ? "shell-exited"
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

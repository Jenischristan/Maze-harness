import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage, SessionEntry, SessionMeta } from "../types.js";
import { SessionStore, listSessions, type SessionInfo } from "./store.js";
import { writeFileAtomic } from "../util/atomic.js";

export interface SessionAction {
  action: "new" | "clone" | "fork" | "resume" | "name" | "list" | "delete";

  id?: string;

  name?: string;

  at?: string;
}

export function parseSessionArgs(args: string): SessionAction {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { action: "list" };
  const verb = parts[0]!.toLowerCase();
  const rest = parts.slice(1);
  switch (verb) {
    case "new":
      return { action: "new", name: rest.join(" ") || undefined };
    case "clone":
      return { action: "clone", id: rest[0] };
    case "fork":
      return { action: "fork", id: rest[0], at: rest[1] };
    case "resume":
      return { action: "resume", id: rest[0] };
    case "name":
      return { action: "name", name: rest.join(" ") };
    case "delete":
    case "rm":
      return { action: "delete", id: rest[0] };
    case "list":
    case "ls":
      return { action: "list" };
    default:
      return { action: "resume", id: verb };
  }
}

export interface SessionSummaryLine {
  runId: string;
  name?: string;
  messageCount: number;
  tokens: number;
  usd: number;
  lastActive: string;
  active: boolean;
}

export async function sessionLines(
  dir: string,
  activeId: string | null
): Promise<SessionSummaryLine[]> {
  const sessions = await listSessions(dir);
  return sessions.map((s) => ({
    runId: s.runId,
    name: s.name,
    messageCount: s.messageCount,
    tokens: s.tokens,
    usd: s.usd,
    lastActive: s.lastActive,
    active: s.runId === activeId
  }));
}

function resolveSessionPath(dir: string, id: string | undefined): string {
  if (!id) throw new Error("session id required");
  if (id.endsWith(".jsonl")) return resolve(id);
  return join(dir, `${id}.jsonl`);
}

async function findSessionPath(dir: string, id: string): Promise<string | null> {
  const direct = resolveSessionPath(dir, id);
  if (existsSync(direct)) return direct;
  const match = (await listSessions(dir)).find((s) => s.runId === id || s.runId.startsWith(id));
  return match?.path ?? null;
}

async function readMeta(path: string): Promise<SessionMeta | null> {
  const raw = await readFile(path, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as SessionEntry;
      if (e.kind === "header" && e.note) return JSON.parse(e.note) as SessionMeta;
    } catch {
      void 0;
    }
  }
  return null;
}

async function rewriteHeader(path: string, patch: Partial<SessionMeta>): Promise<void> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i]?.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as SessionEntry;
      if (e.kind === "header" && e.note) {
        const meta = JSON.parse(e.note) as SessionMeta;
        e.note = JSON.stringify({ ...meta, ...patch });
        lines[i] = JSON.stringify(e);

        await writeFileAtomic(path, lines.join("\n"));
        return;
      }
    } catch {
      void 0;
    }
  }
}

export async function cloneSession(
  dir: string,
  sourceId: string,
  mode: "clone" | "fork",
  opts: { at?: string; name?: string; model?: string } = {}
): Promise<SessionStore> {
  const srcPath = await findSessionPath(dir, sourceId);
  if (!srcPath) throw new Error(`session not found: ${sourceId}`);
  const srcMeta = await readMeta(srcPath);
  const runId = `session-${randomUUID().slice(0, 8)}`;
  const store = new SessionStore({
    dir,
    runId,
    model: opts.model ?? srcMeta?.model ?? "unknown",
    name: opts.name ?? (srcMeta?.name ? `${srcMeta.name} (${mode})` : undefined),
    cwd: srcMeta?.cwd
  });
  await store.init();

  const src = new SessionStore({
    dir: dirname(srcPath),
    runId:
      srcPath
        .split("/")
        .pop()
        ?.replace(/\.jsonl$/, "") ?? "source"
  });
  await src.init();

  try {
    if (mode === "clone") {
      for (const m of src.projection()) {
        if (m.synthetic) continue;
        await store.appendMessage({ ...m, createdAt: new Date().toISOString() });
      }
      return store;
    }

    const branch = src.activeBranch();
    // Validate the fork point before copying so a bad `--at` never leaves a
    // half-written session file behind.
    if (opts.at && !branch.some((e) => e.id === opts.at)) {
      throw new Error(`fork point not on active branch: ${opts.at}`);
    }
    for (const e of branch) {
      if (e.kind === "header") continue;
      if (e.id === opts.at) break;
      if (e.kind === "message" && e.message) {
        await store.appendMessage(e.message);
      } else if (e.kind === "tool_call" && e.toolCall) {
        await store.appendToolCall(e.toolCall);
      } else if (e.kind === "tool_result" && e.toolResult) {
        await store.appendToolResult(e.toolResult);
      } else if (e.kind === "note" && e.note) {
        await store.appendNote(e.note);
      }
    }
    return store;
  } catch (err) {
    // A fork that fails mid-copy must not leave an empty orphan session.
    await rm(store.path, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function renameSession(dir: string, id: string, name: string): Promise<string> {
  const path = await findSessionPath(dir, id);
  if (!path) throw new Error(`session not found: ${id}`);
  const clean = name.trim();
  if (!clean) throw new Error("name cannot be empty");
  await rewriteHeader(path, { name: clean });
  return clean;
}

export async function deleteSession(dir: string, id: string): Promise<void> {
  const path = await findSessionPath(dir, id);
  if (!path) throw new Error(`session not found: ${id}`);
  await rm(path, { force: true });
}

export async function resumeSession(dir: string, id: string): Promise<SessionStore> {
  const path = await findSessionPath(dir, id);
  if (!path) throw new Error(`session not found: ${id}`);
  const runId =
    path
      .split("/")
      .pop()
      ?.replace(/\.jsonl$/, "") ?? id;
  const store = new SessionStore({ dir: dirname(path), runId });
  await store.init();
  return store;
}

async function ensureSessionDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

interface ResumeMessage {
  role: string;
  content: string;
}

export function projectionToBlocks(
  messages: ChatMessage[]
): Array<{ kind: "user" | "assistant" | "note"; text: string }> {
  const out: Array<{ kind: "user" | "assistant" | "note"; text: string }> = [];
  for (const m of messages) {
    if (m.synthetic) {
      out.push({ kind: "note", text: m.content });
      continue;
    }
    if (m.role === "user") out.push({ kind: "user", text: m.content });
    else if (m.role === "assistant") {
      const text =
        m.content ||
        (m.toolCalls?.length ? `(called ${m.toolCalls.map((c) => c.name).join(", ")})` : "");
      if (text) out.push({ kind: "assistant", text });
    }
  }
  return out;
}

async function listSessionFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatMessage, SessionEntry, SessionMeta, ToolCall, ToolResult } from "../types.js";
import { appendLineSafe } from "../util/atomic.js";

export interface SessionStoreConfig {
  dir: string;
  runId?: string;
  name?: string;
  model?: string;
  cwd?: string;
}

export interface SessionInfo {
  path: string;
  runId: string;
  name?: string;
  messageCount: number;
  entryCount: number;
  createdAt: string;
  tokens: number;
  usd: number;
  lastActive: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number;
}

/**
 * Append-only JSONL session store. Each line is a SessionEntry; entries form a
 * tree via parentId. The active branch is the path ending at `head`. Compaction
 * and checkpoint entries are persisted but original messages are never deleted,
 * so any session can be resumed, replayed, or forked.
 */
export class SessionStore {
  readonly dir: string;
  readonly path: string;
  readonly meta: SessionMeta;
  private head: string | null = null;
  private readonly entries: SessionEntry[] = [];

  constructor(cfg: SessionStoreConfig) {
    this.dir = cfg.dir;
    const runId = cfg.runId ?? `session-${randomUUID().slice(0, 8)}`;
    this.path = join(cfg.dir, `${runId}.jsonl`);
    this.meta = {
      version: 1,
      runId,
      model: cfg.model ?? "unknown",
      createdAt: new Date().toISOString(),
      cwd: cfg.cwd ?? process.cwd(),
      name: cfg.name
    };
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      await appendLineSafe(this.path, JSON.stringify(this.headerEntry()));
    }
    await this.load();
  }

  async load(): Promise<void> {
    const raw = await readFile(this.path, "utf8").catch(() => "");
    this.entries.length = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.entries.push(JSON.parse(trimmed) as SessionEntry);
      } catch {
        // skip corrupt line
      }
    }
    this.head = this.entries.length > 0 ? this.entries[this.entries.length - 1]!.id : null;
  }

  get activeHead(): string | null {
    return this.head;
  }

  get allEntries(): ReadonlyArray<SessionEntry> {
    return this.entries;
  }

  private headerEntry(): SessionEntry {
    return {
      id: "hdr",
      parentId: null,
      kind: "header",
      timestamp: this.meta.createdAt,
      note: JSON.stringify(this.meta)
    };
  }

  private async append(entry: SessionEntry): Promise<void> {
    this.entries.push(entry);
    this.head = entry.id;
    // Atomic-ish append: a torn trailing line from a crashed writer is
    // terminated before the new record so both remain parseable.
    await appendLineSafe(this.path, JSON.stringify(entry));
  }

  async appendMessage(message: ChatMessage): Promise<SessionEntry> {
    const entry: SessionEntry = {
      id: `m-${shortId()}`,
      parentId: this.head,
      kind: "message",
      timestamp: new Date().toISOString(),
      message
    };
    await this.append(entry);
    return entry;
  }

  async appendToolCall(call: ToolCall, parentId?: string): Promise<SessionEntry> {
    const entry: SessionEntry = {
      id: `tc-${call.id || shortId()}`,
      parentId: parentId ?? this.head,
      kind: "tool_call",
      timestamp: new Date().toISOString(),
      toolCall: call
    };
    await this.append(entry);
    return entry;
  }

  async appendToolResult(result: ToolResult, parentId?: string): Promise<SessionEntry> {
    const entry: SessionEntry = {
      id: `tr-${shortId()}`,
      parentId: parentId ?? this.head,
      kind: "tool_result",
      timestamp: new Date().toISOString(),
      toolResult: result
    };
    await this.append(entry);
    return entry;
  }

  async appendCompaction(summary: string, firstKeptEntryId: string | null): Promise<SessionEntry> {
    const entry: SessionEntry = {
      id: `cp-${shortId()}`,
      parentId: this.head,
      kind: "compaction",
      timestamp: new Date().toISOString(),
      compaction: { summary, firstKeptEntryId }
    };
    await this.append(entry);
    return entry;
  }

  async appendCheckpoint(label: string, ref: string): Promise<SessionEntry> {
    const entry: SessionEntry = {
      id: `ck-${shortId()}`,
      parentId: this.head,
      kind: "checkpoint",
      timestamp: new Date().toISOString(),
      checkpoint: { label, ref }
    };
    await this.append(entry);
    return entry;
  }

  async appendNote(note: string): Promise<SessionEntry> {
    const entry: SessionEntry = {
      id: `n-${shortId()}`,
      parentId: this.head,
      kind: "note",
      timestamp: new Date().toISOString(),
      note
    };
    await this.append(entry);
    return entry;
  }

  /**
   * Id of the session entry that produced the message at `index` in
   * `projection()` (i.e. counting only message-bearing entries). Used by
   * compaction to persist a boundary the projection can actually honor.
   */
  entryIdForProjectedIndex(index: number): string | null {
    if (index < 0) return null;
    let seen = -1;
    for (const e of this.activeBranch()) {
      const isMessage = e.kind === "message";
      const isResult = e.kind === "tool_result";
      if (!isMessage && !isResult) continue;
      seen += 1;
      if (seen === index) return e.id;
    }
    return null;
  }

  /** Walk from head to root and return entries oldest-first (active branch). */
  activeBranch(): SessionEntry[] {
    const byId = new Map(this.entries.map((e) => [e.id, e]));
    const out: SessionEntry[] = [];
    let cur = this.head ? byId.get(this.head) : undefined;
    while (cur) {
      out.push(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return out.reverse();
  }

  /**
   * Rebuild the message projection sent to the model. Handles compactions
   * cumulatively: a compaction entry replaces everything before its kept
   * boundary with its summary (nested compactions keep older summaries too).
   */
  projection(): ChatMessage[] {
    const branch = this.activeBranch();
    const messages: ChatMessage[] = [];
    let pendingSummary: string | null = null;
    let skipUntil: string | null = null;
    // First pass: find the last compaction and its kept boundary.
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const e = branch[i]!;
      if (e.kind === "compaction" && e.compaction) {
        pendingSummary = e.compaction.summary;
        skipUntil = e.compaction.firstKeptEntryId;
        break;
      }
    }
    // The first user message is the task; it must survive compaction so the
    // goal is never lost. Remember it before skipping so it can be re-added.
    const firstUser = branch.find((e) => e.kind === "message" && e.message?.role === "user");
    let skipping = skipUntil !== null;
    for (const e of branch) {
      if (e.kind === "header") continue;
      if (skipping && skipUntil !== null) {
        if (e.id === skipUntil) skipping = false;
        else {
          // Keep only the original task message from the skipped region.
          if (e.id === firstUser?.id && e.message) messages.push(e.message);
          continue;
        }
      }
      if (e.kind === "message" && e.message) {
        messages.push(e.message);
      } else if (e.kind === "tool_call" && e.toolCall) {
        // Tool calls are normally embedded in the assistant message that
        // requested them. When that message is missing (fork/clone can drop
        // it, and a fork point may fall between the call and its result), the
        // result below would carry a dangling `tool_call_id`, which strict
        // providers reject. Fold a standalone call into a synthetic assistant
        // message so every tool result has a matching tool_calls entry.
        const last = messages.at(-1);
        const already = last?.role === "assistant" &&
          (last.toolCalls ?? []).some((c) => c.id === e.toolCall!.id);
        if (!already) {
          const pending = last?.role === "assistant" && !last.toolCalls;
          if (pending) {
            last.toolCalls = [e.toolCall];
          } else {
            messages.push({
              role: "assistant",
              content: "",
              toolCalls: [e.toolCall],
              synthetic: true
            });
          }
        }
      } else if (e.kind === "tool_result" && e.toolResult) {
        const r = e.toolResult;
        // Guarantee the result's call id exists on a preceding assistant
        // turn. When the requesting assistant message is missing (fork/clone
        // can drop it), synthesize a matching tool call so the transcript is
        // always valid for strict providers instead of leaving a dangling
        // `tool_call_id`.
        const hasCall = messages.some(
          (m) => m.role === "assistant" && (m.toolCalls ?? []).some((c) => c.id === r.callId)
        );
        if (!hasCall) {
          messages.push({
            role: "assistant",
            content: "",
            toolCalls: [{ id: r.callId, name: r.name, arguments: {} }],
            synthetic: true
          });
        }
        messages.push({
          role: "tool",
          content: r.content,
          toolCallId: r.callId,
          name: r.name
        });
      }
    }
    if (pendingSummary) {
      messages.unshift({
        role: "system",
        content: `## Summary of earlier conversation\n\n${pendingSummary}`,
        synthetic: true
      });
    }
    return messages;
  }

  usageFromEntries(): TokenUsage {
    const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, usd: 0 };
    for (const e of this.entries) {
      if (e.kind === "note" && typeof e.note === "string") {
        const m = /^usage:(\{.*\})$/.exec(e.note);
        if (!m) continue;
        try {
          const parsed = JSON.parse(m[1]!) as Partial<TokenUsage>;
          usage.promptTokens += parsed.promptTokens ?? 0;
          usage.completionTokens += parsed.completionTokens ?? 0;
          usage.totalTokens += parsed.totalTokens ?? 0;
          usage.usd += parsed.usd ?? 0;
        } catch {
          // ignore
        }
      }
    }
    return usage;
  }

  async recordUsage(u: TokenUsage): Promise<void> {
    await this.appendNote(`usage:${JSON.stringify(u)}`);
  }
}

/** Read up to `len` bytes starting at `offset`. */
async function readChunk(path: string, offset: number, len: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, offset);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Read the last `len` bytes of a file, dropping a partial first line. */
async function readTail(path: string, len: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - len);
    const buf = Buffer.alloc(Math.min(len, size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    await fh.close();
  }
}

function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

/** List session files in a directory with basic metadata. */
export async function listSessions(dir: string): Promise<SessionInfo[]> {
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const file of files) {
    const path = join(dir, file);
    // Read the header first, then only the tail for counts/usage. Reading an
    // unbounded JSONL file in full on every /sessions was O(total bytes) and
    // made listing slow as sessions grew.
    const head = await readChunk(path, 0, 64 * 1024).catch(() => "");
    let meta: SessionMeta | null = null;
    for (const line of head.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as SessionEntry;
        if (e.kind === "header" && e.note) {
          meta = JSON.parse(e.note) as SessionMeta;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (!meta) continue;
    const tail = await readTail(path, 256 * 1024).catch(() => "");
    const lines = tail.split("\n").filter((l) => l.trim());
    let messageCount = 0;
    let lastActive = "";
    let tokens = 0;
    let usd = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as SessionEntry;
        if (e.kind === "message") messageCount += 1;
        if (e.kind === "note" && typeof e.note === "string") {
          const m = /^usage:(\{.*\})$/.exec(e.note);
          if (m) {
            const parsed = JSON.parse(m[1]!) as Partial<TokenUsage>;
            tokens += parsed.totalTokens ?? 0;
            usd += parsed.usd ?? 0;
          }
        }
        lastActive = e.timestamp;
      } catch {
        // ignore
      }
    }
    out.push({
      path,
      runId: meta.runId,
      name: meta.name,
      messageCount,
      entryCount: lines.length,
      createdAt: meta.createdAt,
      tokens,
      usd,
      lastActive
    });
  }
  return out.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
}

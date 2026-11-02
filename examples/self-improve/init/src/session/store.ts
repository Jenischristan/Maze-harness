import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatMessage, SessionEntry, SessionMeta, ToolCall, ToolResult } from "../types.js";

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
      await appendFile(this.path, `${JSON.stringify(this.headerEntry())}\n`, "utf8");
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
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
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
    let skipping = skipUntil !== null;
    for (const e of branch) {
      if (e.kind === "header") continue;
      if (skipping) {
        if (e.id === skipUntil) skipping = false;
        else continue;
      }
      if (e.kind === "message" && e.message) {
        messages.push(e.message);
      } else if (e.kind === "tool_call" && e.toolCall) {
        // tool calls are embedded in assistant messages already; ignore here.
      } else if (e.kind === "tool_result" && e.toolResult) {
        const r = e.toolResult;
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

export function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

export function entryHash(entry: SessionEntry): string {
  return createHash("sha1").update(JSON.stringify(entry)).digest("hex").slice(0, 12);
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
    const raw = await readFile(path, "utf8").catch(() => "");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length === 0) continue;
    let meta: SessionMeta | null = null;
    let messageCount = 0;
    let lastActive = "";
    let tokens = 0;
    let usd = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as SessionEntry;
        if (e.kind === "header" && e.note) meta = JSON.parse(e.note) as SessionMeta;
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
    if (!meta) continue;
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

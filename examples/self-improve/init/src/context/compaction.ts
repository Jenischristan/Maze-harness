import type { ChatMessage, ChatProvider } from "../types.js";

export interface CompactionConfig {
  /** Context window in tokens. */
  contextWindow: number;
  /** Tokens reserved for the next response + tools. */
  reserveTokens: number;
  /** Recent tokens kept verbatim after a cut. */
  keepRecentTokens: number;
  /** Trigger compaction when projected tokens exceed this. */
  threshold?: number;
}

export const DEFAULT_COMPACTION: Omit<CompactionConfig, "contextWindow"> = {
  reserveTokens: 16_384,
  keepRecentTokens: 20_000
};

/** Cheap token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(m: ChatMessage): number {
  if (typeof m.tokens === "number") return m.tokens;
  let n = estimateTokens(m.content ?? "");
  if (m.toolCalls) {
    for (const c of m.toolCalls) n += estimateTokens(JSON.stringify(c.arguments)) + 8;
  }
  n += 4;
  return n;
}

export function projectTokens(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.compacted) continue;
    n += estimateMessageTokens(m);
  }
  return n;
}

export function shouldCompact(messages: ChatMessage[], cfg: CompactionConfig): boolean {
  const threshold =
    cfg.threshold ?? Math.max(1024, cfg.contextWindow - cfg.reserveTokens);
  return projectTokens(messages) > threshold;
}

export interface CompactionResult {
  /** Messages to send (summary + kept tail), with `compacted` flags on originals. */
  messages: ChatMessage[];
  summary: string;
  /** Index into the original array of the first kept message, or -1. */
  firstKeptIndex: number;
  tokensBefore: number;
  tokensAfter: number;
  compactedCount: number;
}

/**
 * Find a cut point by walking backwards until keepRecentTokens is reached.
 * Never cuts so that a tool result is separated from its tool call.
 */
function findCut(messages: ChatMessage[], keepRecentTokens: number): number {
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.compacted) continue;
    tokens += estimateMessageTokens(m);
    if (tokens >= keepRecentTokens) {
      let cut = i;
      // Don't cut immediately after an assistant tool call without its result.
      while (cut < messages.length && messages[cut]?.role === "tool") cut += 1;
      return cut;
    }
  }
  return 0;
}

export async function compact(
  messages: ChatMessage[],
  provider: Pick<ChatProvider, "summarize">,
  cfg: CompactionConfig,
  signal?: AbortSignal
): Promise<CompactionResult> {
  const tokensBefore = projectTokens(messages);
  const cut = findCut(messages, cfg.keepRecentTokens);
  const toSummarize = messages.slice(0, cut).filter((m) => !m.compacted && !m.synthetic);
  if (toSummarize.length === 0) {
    return {
      messages: [...messages],
      summary: "",
      firstKeptIndex: cut,
      tokensBefore,
      tokensAfter: tokensBefore,
      compactedCount: 0
    };
  }
  const summary = await provider.summarize(toSummarize, signal);
  const summaryMessage: ChatMessage = {
    role: "system",
    content: `## Summary of earlier conversation\n\n${summary}`,
    synthetic: true,
    createdAt: new Date().toISOString()
  };
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (i < cut) {
      out.push({ ...m, compacted: true });
    } else {
      out.push(m);
    }
  }
  const kept = out.filter((m) => !m.compacted);
  const final = [summaryMessage, ...kept];
  return {
    messages: final,
    summary,
    firstKeptIndex: cut,
    tokensBefore,
    tokensAfter: projectTokens(final),
    compactedCount: toSummarize.length
  };
}

export function formatSummaryPrompt(messages: ChatMessage[]): string {
  const parts: string[] = [];
  parts.push(
    "Summarize the following agent conversation for continuation. Preserve: the user's goal, decisions made, files read or modified, commands run and their outcomes, unresolved errors, and any conventions or gotchas discovered. Be concise but concrete; use bullet points. Do not invent facts."
  );
  parts.push("");
  for (const m of messages) {
    if (m.role === "tool") {
      parts.push(`TOOL(${m.name ?? "?"}): ${truncate(m.content, 1500)}`);
    } else if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      parts.push(
        `ASSISTANT: ${m.content || "(tool calls)"} → ${m.toolCalls
          .map((c) => `${c.name}(${truncate(JSON.stringify(c.arguments), 300)})`)
          .join(", ")}`
      );
    } else {
      parts.push(`${m.role.toUpperCase()}: ${truncate(m.content, 4000)}`);
    }
  }
  return parts.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

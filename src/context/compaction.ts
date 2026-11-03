import type { ChatMessage, ChatProvider } from "../types.js";

export interface CompactionConfig {
  contextWindow: number;

  reserveTokens: number;

  keepRecentTokens: number;

  threshold?: number;

  pruneToolOutputs?: boolean;

  pruneToolOutputMinTokens?: number;
}

export const DEFAULT_COMPACTION: Omit<CompactionConfig, "contextWindow"> = {
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  pruneToolOutputs: true,
  pruneToolOutputMinTokens: 800
};

export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}

const ESTIMATE_SAFETY = 1.15;

function estimateMessageTokens(m: ChatMessage): number {
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

export function shouldCompact(
  messages: ChatMessage[],
  cfg: CompactionConfig,
  observedPromptTokens?: number
): boolean {
  const threshold = cfg.threshold ?? Math.max(1024, cfg.contextWindow - cfg.reserveTokens);
  if (typeof observedPromptTokens === "number" && observedPromptTokens > 0) {
    return observedPromptTokens > threshold;
  }
  return projectTokens(messages) * ESTIMATE_SAFETY > threshold;
}

export interface CompactionResult {
  messages: ChatMessage[];
  summary: string;

  firstKeptIndex: number;

  firstKeptEntryId: string | null;
  tokensBefore: number;
  tokensAfter: number;
  compactedCount: number;
}

function findCut(messages: ChatMessage[], keepRecentTokens: number): number {
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.compacted) continue;
    tokens += estimateMessageTokens(m);
    if (tokens >= keepRecentTokens) {
      let cut = i;

      while (cut < messages.length && messages[cut]?.role === "tool") cut += 1;
      return cut;
    }
  }
  return 0;
}

export function prunedPlaceholder(name: string, bytes: number): string {
  return `[old tool output pruned by compaction: ${name}, ${bytes} bytes. Re-run the tool if the content is still needed.]`;
}

export function pruneToolOutputs(
  messages: ChatMessage[],
  opts: { minTokens: number; keepRecentTokens: number }
): { messages: ChatMessage[]; pruned: number } {
  const cut = findCut(messages, opts.keepRecentTokens);
  let pruned = 0;
  const out = messages.map((m, i) => {
    if (i >= cut || m.role !== "tool") return m;
    if (m.content.startsWith("[old tool output pruned")) return m;
    if (estimateMessageTokens(m) < opts.minTokens) return m;
    pruned += 1;
    return { ...m, content: prunedPlaceholder(m.name ?? "tool", Buffer.byteLength(m.content)) };
  });
  return { messages: out, pruned };
}

export async function compact(
  messages: ChatMessage[],
  provider: Pick<ChatProvider, "summarize">,
  cfg: CompactionConfig,
  signal?: AbortSignal
): Promise<CompactionResult> {
  const tokensBefore = projectTokens(messages);
  let working = messages;
  if (cfg.pruneToolOutputs !== false) {
    const pruned = pruneToolOutputs(working, {
      minTokens: cfg.pruneToolOutputMinTokens ?? 800,
      keepRecentTokens: cfg.keepRecentTokens
    });
    working = pruned.messages;
  }
  const cut = findCut(working, cfg.keepRecentTokens);

  const priorSummaries = working
    .slice(0, cut)
    .filter((m) => m.synthetic && m.role === "system")
    .map((m) => m.content.replace(/^## Summary of earlier conversation\s*\n*/, "").trim())
    .filter(Boolean);
  const toSummarize = working
    .slice(0, cut)
    .filter((m) => !m.compacted && !(m.synthetic && m.role === "system"));
  if (toSummarize.length === 0 && priorSummaries.length === 0) {
    return {
      messages: [...working],
      summary: "",
      firstKeptIndex: cut,
      firstKeptEntryId: null,
      tokensBefore,
      tokensAfter: tokensBefore,
      compactedCount: 0
    };
  }
  const summary = await provider.summarize(
    [
      ...(priorSummaries.length > 0
        ? [
            {
              role: "system" as const,
              content: `## Summary of earlier conversation\n\n${priorSummaries.join("\n\n")}`
            }
          ]
        : []),
      ...toSummarize
    ],
    signal
  );
  const summaryMessage: ChatMessage = {
    role: "system",
    content: `## Summary of earlier conversation\n\n${summary}`,
    synthetic: true,
    createdAt: new Date().toISOString()
  };
  const out: ChatMessage[] = [];
  for (let i = 0; i < working.length; i += 1) {
    const m = working[i]!;
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
    firstKeptEntryId: null,
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

import type {
  ChatMessage,
  ChatProvider,
  ChatResult,
  ToolCall,
  ToolDefinition,
  ToolResult
} from "../types.js";
import type { ToolExecutor } from "../tools/index.js";
import type { HookResult } from "../tools/hookTypes.js";
import {
  projectTokens,
  shouldCompact,
  compact,
  type CompactionConfig
} from "../context/compaction.js";
import { CostTracker } from "../cost.js";
import type { SessionStore } from "../session/store.js";

export type AgentEvent =
  | { type: "assistant"; content: string; toolCalls: ToolCall[] }
  | { type: "tool-start"; calls: ToolCall[] }
  | { type: "tool-result"; result: ToolResult }
  | { type: "hooks"; results: HookResult[] }
  | { type: "compaction"; tokensBefore: number; tokensAfter: number; summary: string }
  | { type: "usage"; promptTokens: number; completionTokens: number; usd: number }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };

export interface AgentLoopConfig {
  provider: ChatProvider;
  tools: ToolDefinition[];
  executor: ToolExecutor;
  session: SessionStore;
  systemPrompt: string;
  maxTurns: number;
  compaction: CompactionConfig;
  cost: CostTracker;
  /** Called before every model request (turn >= 1). */
  onTurn?: (turn: number) => void;
  /** Receives streamed agent events. */
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Stop if the same tool batch repeats this many turns in a row. */
  loopTurnLimit?: number;
}

export interface AgentLoopResult {
  messages: ChatMessage[];
  stopReason: "done" | "max-turns" | "loop" | "error" | "aborted";
  error?: string;
  turns: number;
}

/**
 * The agent loop: send context → model responds → execute tool calls → repeat.
 * Handles compaction, cost tracking, tool-error recovery, loop detection, and
 * abort. Every message and tool result is persisted to the session so the run
 * can be resumed or replayed.
 */
export async function runAgentLoop(
  cfg: AgentLoopConfig,
  userMessage: string
): Promise<AgentLoopResult> {
  const emit = (e: AgentEvent): void => {
    cfg.onEvent?.(e);
  };
  await cfg.session.appendMessage({ role: "user", content: userMessage });

  let turns = 0;
  let lastSignature = "";
  let repeated = 0;
  const loopLimit = cfg.loopTurnLimit ?? 5;

  while (turns < cfg.maxTurns) {
    if (cfg.signal?.aborted) {
      return { messages: cfg.session.projection(), stopReason: "aborted", turns };
    }
    turns += 1;
    cfg.onTurn?.(turns);

    const system: ChatMessage = { role: "system", content: cfg.systemPrompt };
    let messages = [system, ...cfg.session.projection()];

    if (shouldCompact(messages, cfg.compaction)) {
      try {
        const result = await compact(messages, cfg.provider, cfg.compaction, cfg.signal);
        if (result.compactedCount > 0) {
          // The projection is `[system, ...branch]`; offset by one to map the
          // cut index back to a session entry id. Persisting that boundary is
          // what makes the compaction actually shrink the context.
          const projection = cfg.session.projection();
          const keptMsg = result.messages.slice(1).find((m) => !m.compacted);
          const keptIndex = keptMsg ? projection.indexOf(keptMsg) : -1;
          const firstKeptEntryId =
            keptIndex >= 0 ? cfg.session.entryIdForProjectedIndex(keptIndex) : null;
          await cfg.session.appendCompaction(result.summary, firstKeptEntryId);
          emit({
            type: "compaction",
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            summary: result.summary
          });
          messages = [system, ...cfg.session.projection()];
        }
      } catch (err) {
        emit({
          type: "error",
          message: `compaction failed: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    }

    let response: ChatResult;
    try {
      response = await cfg.provider.complete(messages, cfg.tools, cfg.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message: `model request failed: ${message}` });
      return { messages: cfg.session.projection(), stopReason: "error", error: message, turns };
    }

    const usage = cfg.cost.record(response.usage);
    await cfg.session.recordUsage({
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      usd: usage.usd ?? 0
    });
    emit({
      type: "usage",
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      usd: usage.usd ?? 0
    });

    const assistant = response.message;
    await cfg.session.appendMessage(assistant);
    emit({
      type: "assistant",
      content: assistant.content,
      toolCalls: assistant.toolCalls ?? []
    });

    if (!assistant.toolCalls || assistant.toolCalls.length === 0) {
      emit({ type: "done", stopReason: response.stopReason });
      return { messages: cfg.session.projection(), stopReason: "done", turns };
    }

    const signature = assistant.toolCalls
      .map((c) => `${c.name}:${JSON.stringify(c.arguments)}`)
      .sort()
      .join("|");
    if (signature === lastSignature) {
      repeated += 1;
    } else {
      repeated = 0;
      lastSignature = signature;
    }
    if (repeated >= loopLimit) {
      const message = `loop detected: identical tool batch repeated ${repeated + 1} times`;
      emit({ type: "error", message });
      return { messages: cfg.session.projection(), stopReason: "loop", error: message, turns };
    }

    emit({ type: "tool-start", calls: assistant.toolCalls });
    // Forward the turn's abort signal so pressing esc kills in-flight tool
    // subprocesses instead of waiting out the tool's own timeout.
    cfg.executor.setSignal(cfg.signal);
    const batch = await cfg.executor.runBatch(
      assistant.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))
    );
    for (const result of batch.results) {
      await cfg.session.appendToolResult(result);
      emit({ type: "tool-result", result });
    }
    if (batch.hookResults.length > 0) emit({ type: "hooks", results: batch.hookResults });
  }

  return { messages: cfg.session.projection(), stopReason: "max-turns", turns };
}

export function contextUsage(
  messages: ChatMessage[],
  contextWindow: number
): { tokens: number; pct: number } {
  const tokens = projectTokens(messages);
  return { tokens, pct: contextWindow > 0 ? Math.min(1, tokens / contextWindow) : 0 };
}

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
  estimateTokens,
  type CompactionConfig
} from "../context/compaction.js";
import type { CostTracker } from "../cost.js";
import type { SessionStore } from "../session/store.js";
import {
  Budget,
  describeBudgetExceeded,
  type BudgetLimits,
  type BudgetState
} from "../util/limits.js";
import { getLogger } from "../util/logger.js";

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

  onTurn?: (turn: number) => void;

  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;

  loopTurnLimit?: number;

  budget?: BudgetLimits;

  stream?: (
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ) => Promise<ChatResult>;

  beginTurn?: () => Promise<() => Promise<void>>;
}

export interface AgentLoopResult {
  messages: ChatMessage[];
  stopReason: "done" | "max-turns" | "loop" | "error" | "aborted" | "budget";
  error?: string;
  turns: number;

  budget?: BudgetState;
}

export async function runAgentLoop(
  cfg: AgentLoopConfig,
  userMessage: string
): Promise<AgentLoopResult> {
  const log = getLogger("agent.loop", { model: cfg.provider.model });
  const emit = (e: AgentEvent): void => {
    cfg.onEvent?.(e);
  };
  await cfg.session.appendMessage({ role: "user", content: userMessage });

  const budget = new Budget({ ...cfg.budget, maxTurns: cfg.maxTurns });
  let turns = 0;
  let lastSignature = "";
  let repeated = 0;

  let lastPromptTokens: number | undefined;
  const loopLimit = cfg.loopTurnLimit ?? 5;
  const stopForBudget = (): AgentLoopResult => {
    const exceeded = budget.check();
    const message = exceeded ? describeBudgetExceeded(exceeded) : "budget exceeded";

    const stopReason: AgentLoopResult["stopReason"] =
      exceeded?.kind === "turns" ? "max-turns" : "budget";
    log.warn("budget stop", {
      kind: exceeded?.kind,
      limit: exceeded?.limit,
      used: exceeded?.used,
      turns
    });
    emit({ type: "error", message });
    return {
      messages: cfg.session.projection(),
      stopReason,
      error: message,
      turns,
      budget: budget.used
    };
  };

  while (turns < cfg.maxTurns) {
    if (cfg.signal?.aborted) {
      return { messages: cfg.session.projection(), stopReason: "aborted", turns };
    }

    if (budget.check()) return stopForBudget();
    turns += 1;
    budget.turn();
    cfg.onTurn?.(turns);

    const system: ChatMessage = { role: "system", content: cfg.systemPrompt };
    let messages = [system, ...cfg.session.projection()];

    if (shouldCompact(messages, cfg.compaction, lastPromptTokens)) {
      try {
        const summaryProvider = {
          summarize: async (msgs: ChatMessage[], sig?: AbortSignal) => {
            const text = await cfg.provider.summarize(msgs, sig);
            const promptTokens = msgs.reduce((n, m) => n + estimateTokens(m.content ?? ""), 0);
            const completionTokens = estimateTokens(text);
            const billed = cfg.cost.record({
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens
            });
            budget.spend(billed.totalTokens, billed.usd ?? 0);
            return text;
          }
        };
        const result = await compact(messages, summaryProvider, cfg.compaction, cfg.signal);
        if (result.compactedCount > 0) {
          const firstKeptEntryId =
            result.firstKeptIndex >= 0
              ? cfg.session.entryIdForProjectedIndex(result.firstKeptIndex - 1)
              : null;
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
      response = cfg.stream
        ? await cfg.stream(messages, cfg.tools, cfg.signal)
        : await cfg.provider.complete(messages, cfg.tools, cfg.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message: `model request failed: ${message}` });
      return { messages: cfg.session.projection(), stopReason: "error", error: message, turns };
    }

    const usage = cfg.cost.record(response.usage);
    lastPromptTokens = response.usage.promptTokens || undefined;

    budget.spend(
      response.usage.totalTokens || response.usage.promptTokens + response.usage.completionTokens,
      usage.usd ?? 0
    );
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

    cfg.executor.setSignal(cfg.signal);

    const undo = cfg.beginTurn ? await cfg.beginTurn().catch(() => null) : null;
    let batch: Awaited<ReturnType<ToolExecutor["runBatch"]>>;
    try {
      batch = await cfg.executor.runBatch(
        assistant.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))
      );
    } catch (err) {
      if (undo) await undo().catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      log.error("tool batch failed; turn rewound", { turn: turns, error: message });
      emit({ type: "error", message: `tool batch failed: ${message}` });
      return {
        messages: cfg.session.projection(),
        stopReason: "error",
        error: message,
        turns,
        budget: budget.used
      };
    }
    budget.toolCalls(batch.results.length);
    for (const result of batch.results) {
      await cfg.session.appendToolResult(result);
      emit({ type: "tool-result", result });
    }
    if (batch.hookResults.length > 0) emit({ type: "hooks", results: batch.hookResults });

    if (cfg.signal?.aborted && undo) await undo().catch(() => undefined);
    if (budget.check()) return stopForBudget();
  }

  return {
    messages: cfg.session.projection(),
    stopReason: "max-turns",
    turns,
    budget: budget.used
  };
}

export function contextUsage(
  messages: ChatMessage[],
  contextWindow: number
): { tokens: number; pct: number } {
  const tokens = projectTokens(messages);
  return { tokens, pct: contextWindow > 0 ? Math.min(1, tokens / contextWindow) : 0 };
}

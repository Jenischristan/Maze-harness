/**
 * Chat/message and provider types.
 *
 * Re-exported from `src/types.ts`.
 */

import type { ToolCall, ToolDefinition } from "./tool.js";

type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  /** Marks messages that were compacted away (still stored, not sent). */
  compacted?: boolean;
  /** Marks synthetic messages inserted by compaction. */
  synthetic?: boolean;
  /** Token estimate for budgeting. */
  tokens?: number;
  createdAt?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd?: number;
}

export interface ChatResult {
  message: ChatMessage;
  usage: Usage;
  stopReason: "stop" | "tool_calls" | "length" | "error";
}

export interface ChatProvider {
  readonly model: string;
  readonly contextWindow: number;
  complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<ChatResult>;
  /** Summarize a list of messages (used by compaction). */
  summarize(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

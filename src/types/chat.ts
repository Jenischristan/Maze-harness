import type { ToolCall, ToolDefinition } from "./tool.js";

type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;

  compacted?: boolean;

  synthetic?: boolean;

  tokens?: number;
  createdAt?: string;

  reasoning?: string;

  contentBlocks?: ContentBlock[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  | { type: "reasoning"; text: string }
  | { type: "cache_control"; ttl?: "5m" | "1h" };

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;

  cacheReadTokens?: number;

  cacheWriteTokens?: number;

  reasoningTokens?: number;
  usd?: number;
}

export interface ChatResult {
  message: ChatMessage;
  usage: Usage;
  stopReason: "stop" | "tool_calls" | "length" | "error";
}

export type ChatStreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_delta"; index: number; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: Usage }
  | { type: "stop"; stopReason: ChatResult["stopReason"] };

export interface ChatProvider {
  readonly model: string;
  readonly contextWindow: number;

  readonly info?: import("../agent/models.js").ModelInfo;
  complete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<ChatResult>;

  stream?(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncIterable<ChatStreamEvent>;

  summarize(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

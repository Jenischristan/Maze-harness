/**
 * Session persistence types.
 *
 * Re-exported from `src/types.ts`.
 */

import type { ChatMessage } from "./chat.js";
import type { ToolCall, ToolResult } from "./tool.js";

export interface SessionEntry {
  id: string;
  parentId: string | null;
  kind:
    | "header"
    | "message"
    | "tool_call"
    | "tool_result"
    | "compaction"
    | "checkpoint"
    | "note";
  timestamp: string;
  message?: ChatMessage;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  compaction?: { summary: string; firstKeptEntryId: string | null };
  checkpoint?: { label: string; ref: string };
  note?: string;
}

export interface SessionMeta {
  version: number;
  runId: string;
  model: string;
  createdAt: string;
  cwd: string;
  name?: string;
}

interface SessionStateFile {
  runId: string;
  round: number;
  policyId: string;
  policySource: string;
  cumulativeCalls: number;
  results: Array<{
    round: number;
    policyId: string;
    treeIndex: number;
    meanScore: number;
    holdoutScore: number | null;
    cumulativeCalls: number;
  }>;
}

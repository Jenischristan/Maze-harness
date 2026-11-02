/**
 * Tool-calling types shared by the registry, executor, and providers.
 *
 * Re-exported from `src/types.ts`.
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  /** Content shown to the model (may be truncated). */
  content: string;
  /** Bytes discarded by truncation, if any. */
  truncated?: { keptBytes: number; droppedBytes: number; pageToken?: string };
  /** Machine-readable payload for the harness (not sent to the model). */
  data?: unknown;
  error?: string;
}

export interface ToolContext {
  workspaceDir: string;
  /** Files the agent has read this session (for edit-before-read enforcement). */
  readFiles: Set<string>;
  /** Content hash captured when each file was read (stale-edit guard). */
  readHashes?: Map<string, string>;
  /** Files modified this session. */
  modifiedFiles: Set<string>;
  /** Output byte budget per call. */
  maxOutputBytes: number;
  /** Permission policy. */
  permission: import("../tools/permissions.js").PermissionPolicy;
  /** Verification hook registry. */
  hooks: import("../tools/hookTypes.js").HookRegistry;
  /** Per-call wall-clock budget in ms (tool-specific default when omitted). */
  timeoutMs?: number;
  /** Abort signal. */
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema for arguments. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

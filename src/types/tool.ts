export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;

  content: string;

  contentBlocks?: import("./chat.js").ContentBlock[];

  truncated?: { keptBytes: number; droppedBytes: number; pageToken?: string };

  data?: unknown;
  error?: string;
}

export interface ToolContext {
  workspaceDir: string;

  readFiles: Set<string>;

  readHashes?: Map<string, string>;

  modifiedFiles: Set<string>;

  maxOutputBytes: number;

  permission: import("../tools/permissions.js").PermissionPolicy;

  hooks: import("../tools/hookTypes.js").HookRegistry;

  timeoutMs?: number;

  signal?: AbortSignal;

  mediaTypes?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;

  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

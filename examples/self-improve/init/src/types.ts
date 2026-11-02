export type FailClass =
  | "ok"
  | "compile"
  | "runtime"
  | "timeout"
  | "incorrect"
  | "agent_error"
  | "loop"
  | "permission"
  | "truncated"
  | (string & {});

export interface Cost {
  agentCalls: number;
  wallMs: number;
  tokens?: number;
  /** Approximate monetary cost in USD if a price table is configured. */
  usd?: number;
}

export interface DiscoveryNode {
  id: string;
  parentId: string;
  branch: number;
  attempt: number;
  seq: number;
  score: number | null;
  valid: boolean;
  failClass: FailClass;
  error: string | null;
  diagnostics: unknown;
  snapshotRef: string;
  artifactPath: string | null;
  cost: Cost;
  createdAt: string;
}

export interface DiscoveryTree {
  runId: string;
  treeIndex: number;
  baselineScore: number;
  maxParallelism: number;
  roundsLimit: number;
  policyId: string;
  nodes: DiscoveryNode[];
  createdAt: string;
  priorHistory?: TreeSummary[];
}

export interface Observation {
  id: string;
  branch: number;
  attempt: number;
  parentId: string;
  seq: number;
  score: number | null;
  valid: boolean;
  failClass: FailClass;
  error: string | null;
  deltaVsBaseline: number | null;
  deltaVsParent: number | null;
}

export interface TreeSummary {
  treeIndex: number;
  baselineScore: number;
  maxParallelism: number;
  roundsUsed: number;
  nodeCount: number;
  branches: number;
  bestScore: number | null;
  batches: string[][];
}

export interface ExplorationEnv {
  readonly baselineScore: number;
  readonly maxParallelism: number;
  readonly roundsRemaining: number;
  readonly done: boolean;
  observed(): ReadonlyMap<string, Observation>;
  legalActions(): string[];
  legalRoots(): number;
  openedBranches(): number[];
  probeBatch(ids: string[]): Promise<Observation[]>;
  priorHistory(): ReadonlyArray<TreeSummary>;
}

export interface ExplorationPolicy {
  solve(env: ExplorationEnv): Promise<void>;
}

export interface ProbeResult {
  score: number | null;
  valid: boolean;
  failClass: FailClass;
  error: string | null;
  diagnostics: unknown;
}

export interface DiscoveryAgent {
  run(input: {
    workspaceDir: string;
    task: TaskSpec;
    parent: DiscoveryNode | null;
    context: AgentContext;
  }): Promise<{ transcriptPath?: string; tokens?: number }>;
}

export interface AgentContext {
  nodeId: string;
  branch: number;
  attempt: number;
  ancestorPath: Observation[];
  taskPrompt: string;
}

export interface TaskSpec {
  name: string;
  description: string;
  prompt: string;
  initProgramPath: string;
  evaluatorCommand: string[];
  evaluatorTimeoutMs: number;
  agentTimeoutMs: number;
  /** Commands run after every edit to verify the workspace (build/test/lint). */
  verifyCommands?: string[];
}

export interface EvaluatorResult {
  score: number | null;
  valid: boolean;
  failClass: FailClass;
  error: string | null;
  diagnostics: unknown;
}

export interface Evaluator {
  evaluate(workspaceDir: string): Promise<EvaluatorResult>;
}

export interface ReplayReport {
  treeIndex: number;
  policyId: string;
  score: number;
  best: number;
  n: number;
  k: number;
  batches: string[][];
  revealed: Observation[];
  error: string | null;
  illegal: boolean;
  timedOut: boolean;
  wallMs: number;
}

export interface ReplayScoreConfig {
  beta1: number;
  beta2: number;
  normalize: "relativeToBaseline" | "none";
  /**
   * Budget preference rho in [0, 1]: 0 rewards using the budget fully
   * (best score), 1 rewards spending it efficiently (few rounds). Mirrors
   * DREAM-RSI's beta grid.
   */
  rho?: number;
  /** Parallelism penalty lambda: discourages wide batches. */
  lambda?: number;
}

export interface PolicyDeveloper {
  revise(input: {
    currentPolicySource: string;
    replayReports: ReplayReport[];
    previousFeedback: string[];
  }): Promise<string>;
}

export interface FeedbackReport {
  treeIndex: number;
  score: number;
  components: { best: number; n: number; k: number; penalty: number; bonus: number };
  batches: string[][];
  revealed: Observation[];
  error: string | null;
}

export interface PolicyVersionRecord {
  policyId: string;
  source: string;
  meanScore: number;
  scores: number[];
  selected: boolean;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Tool calling                                                        */
/* ------------------------------------------------------------------ */

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
  /** Files modified this session. */
  modifiedFiles: Set<string>;
  /** Output byte budget per call. */
  maxOutputBytes: number;
  /** Permission policy. */
  permission: import("./tools/permissions.js").PermissionPolicy;
  /** Verification hook registry. */
  hooks: import("./tools/hooks.js").HookRegistry;
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

/* ------------------------------------------------------------------ */
/* Chat / messages                                                     */
/* ------------------------------------------------------------------ */

export type Role = "system" | "user" | "assistant" | "tool";

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

/* ------------------------------------------------------------------ */
/* Session persistence                                                 */
/* ------------------------------------------------------------------ */

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

export interface SessionStateFile {
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

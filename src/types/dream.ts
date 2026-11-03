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

interface Cost {
  agentCalls: number;
  wallMs: number;
  tokens?: number;

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

  nValid: number | null;

  nTotal: number | null;

  tags: string[];

  branchPromising: boolean;

  branchFailedHard: boolean;

  improvedVsParent: boolean;

  improvedVsBaseline: boolean;
}

export interface CellMeta {
  id: string;
  branch: number;
  attempt: number;
  parentId: string;
  seq: number;
  tags: string[];
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

  readonly bestSoFar: number | null;

  readonly budgetSpent: number;

  reset(): void;
  observed(): ReadonlyMap<string, Observation>;
  legalActions(): string[];
  legalRoots(): number;
  openedBranches(): number[];

  meta(id: string): CellMeta;
  probeBatch(ids: string[]): Promise<Observation[]>;
  priorHistory(): ReadonlyArray<TreeSummary>;
}

export interface GridPlan {
  branchCount: number;
  refineCount: number;
  reason: string;
}

export interface GridPlanningContext {
  history: ReadonlyArray<{
    round: number;
    plannedBranchCount: number;
    plannedRefineCount: number;
    openedBranches: number;
    maxAttempt: number;
    probes: number;
    rounds: number;
    bestScore: number | null;
    beta: number | null;
  }>;
  fallbackBranchCount: number;
  fallbackRefineCount: number;
  hardMaxBranchCount: number;
  hardMaxRefineCount: number;
  workerCap: number;

  replaySupport: ReadonlyArray<{ traceBranchCount: number; traceRefineCount: number }>;
}

export interface PolicyConfig {
  beta?: number;
  plan?: GridPlan;
}

export interface ExplorationPolicy {
  solve(env: ExplorationEnv): Promise<void>;

  planGrid?(context: GridPlanningContext): GridPlan;
}

interface ProbeResult {
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
  evaluate(workspaceDir: string, signal?: AbortSignal): Promise<EvaluatorResult>;
}

export interface ReplayReport {
  treeIndex: number;
  policyId: string;
  score: number;
  best: number;
  n: number;
  k: number;

  maxParallelism: number;
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

  rho?: number;

  lambda?: number;
}

export interface PolicyDeveloper {
  revise(input: {
    currentPolicySource: string;
    replayReports: ReplayReport[];
    previousFeedback: string[];

    trees?: DiscoveryTree[];

    scoreConfig?: ReplayScoreConfig;
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

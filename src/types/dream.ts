/**
 * Dream-RSI domain types: discovery trees, the exploration environment, the
 * replay report, and policy development.
 *
 * Re-exported from `src/types.ts`; split out so the file stays navigable.
 */

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
  /** Number of validated sub-cases, when the evaluator reports it. */
  nValid: number | null;
  /** Total sub-cases, when the evaluator reports it. */
  nTotal: number | null;
  /** Prefix-safe structural metadata for the cell (see `CellMeta`). */
  tags: string[];
  /**
   * Prefix signals from the paper's `see.policy.observation_signal` helpers.
   * All are derived from the revealed prefix only.
   */
  /** The branch has produced at least one successful improving probe. */
  branchPromising: boolean;
  /** Repeated same-class failures with no prior success on the branch. */
  branchFailedHard: boolean;
  /** Score strictly improved over the parent (baseline for a root child). */
  improvedVsParent: boolean;
  /** Score strictly beats the run's baseline score. */
  improvedVsBaseline: boolean;
}

/**
 * Structural (prefix-safe) metadata for one recorded cell. Mirrors the paper's
 * `question.meta(cell_id) -> CellMeta`; it never exposes unrevealed scores.
 */
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
  /** Best score so far; bookkeeping only — never a decision input. */
  readonly bestSoFar: number | null;
  /** Probes spent so far; bookkeeping only — never a decision input. */
  readonly budgetSpent: number;
  /** Reset per-rollout policy state; replay starts from a clean prefix. */
  reset(): void;
  observed(): ReadonlyMap<string, Observation>;
  legalActions(): string[];
  legalRoots(): number;
  openedBranches(): number[];
  /** Structural metadata for a cell id (root included). */
  meta(id: string): CellMeta;
  probeBatch(ids: string[]): Promise<Observation[]>;
  priorHistory(): ReadonlyArray<TreeSummary>;
}

/**
 * Next-cycle grid plan, mirroring the paper's `GridPlan(branch_count,
 * refine_count)`: W branches, and R refinements allowed after each root.
 */
export interface GridPlan {
  branchCount: number;
  refineCount: number;
  reason: string;
}

export interface GridPlanningContext {
  /** Completed earlier live manifests (one per outer round). */
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
  /** Structural support of the trees that will be replayed this round. */
  replaySupport: ReadonlyArray<{ traceBranchCount: number; traceRefineCount: number }>;
}

/**
 * Config handed to a policy constructor in both the live loop and the replay
 * sandbox. `beta` is the baked-in default for the episode; `plan` is the
 * effective grid plan for this cycle (paper Appendix B.2: "the runtime grid is
 * the hard bound"). Passing the plan through the constructor is what makes a
 * policy's own `planGrid` output actually bound `solve()`; a policy that only
 * remembers the plan on `this` loses it when the sandbox constructs a fresh
 * instance for each replay.
 */
export interface PolicyConfig {
  beta?: number;
  plan?: GridPlan;
}

export interface ExplorationPolicy {
  solve(env: ExplorationEnv): Promise<void>;
  /** Optional per-cycle grid planner; a runtime fallback is used when absent. */
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
  evaluate(workspaceDir: string, signal?: AbortSignal): Promise<EvaluatorResult>;
}

export interface ReplayReport {
  treeIndex: number;
  policyId: string;
  score: number;
  best: number;
  n: number;
  k: number;
  /**
   * Worker cap W for this replay world. The paper's parallel penalty uses
   * `ceil(batchSize / W)` with the world's max parallelism, not the batch's
   * own width.
   */
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
    /**
     * The replay worlds the reports came from. Feedback normalizes against each
     * tree's real baseline; without them a developer has to guess, and earlier
     * code fabricated trees with `baselineScore: report.best`, which is the
     * observed best, not the baseline.
     */
    trees?: DiscoveryTree[];
    /** The score config selection actually used (beta1/beta2/rho/lambda). */
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

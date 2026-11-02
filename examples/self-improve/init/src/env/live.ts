import { randomUUID } from "node:crypto";
import type { GitWorkspace } from "../workspace/git.js";
import { TreeIndex, ROOT_ID, summarizeTree, toObservation } from "../tree.js";
import type {
  AgentContext,
  DiscoveryAgent,
  DiscoveryNode,
  DiscoveryTree,
  Evaluator,
  ExplorationEnv,
  Observation,
  TaskSpec,
  TreeSummary
} from "../types.js";

export interface LiveEnvConfig {
  runId: string;
  treeIndex: number;
  baselineScore: number;
  maxParallelism: number;
  roundsLimit: number;
  policyId: string;
  task: TaskSpec;
  agent: DiscoveryAgent;
  evaluator: Evaluator;
  workspace: GitWorkspace;
  priorHistory: TreeSummary[];
  onTreeChange?: (tree: DiscoveryTree) => Promise<void> | void;
  onRound?: (tree: DiscoveryTree, batch: string[]) => Promise<void> | void;
}

export class LiveEnv implements ExplorationEnv {
  readonly baselineScore: number;
  readonly maxParallelism: number;
  readonly roundsLimit: number;

  private readonly cfg: LiveEnvConfig;
  private readonly index: TreeIndex;
  private readonly observations = new Map<string, Observation>();
  private readonly batches: string[][] = [];
  private roundsUsed = 0;
  private seq = 0;
  private doneFlag = false;
  private agentCalls = 0;

  constructor(cfg: LiveEnvConfig) {
    this.cfg = cfg;
    this.baselineScore = cfg.baselineScore;
    this.maxParallelism = Math.max(1, cfg.maxParallelism);
    this.roundsLimit = Math.max(0, cfg.roundsLimit);
    this.index = new TreeIndex({
      runId: cfg.runId,
      treeIndex: cfg.treeIndex,
      baselineScore: cfg.baselineScore,
      maxParallelism: this.maxParallelism,
      roundsLimit: this.roundsLimit,
      policyId: cfg.policyId,
      nodes: [],
      createdAt: new Date().toISOString()
    });
  }

  get roundsRemaining(): number {
    return this.doneFlag ? 0 : Math.max(0, this.roundsLimit - this.roundsUsed);
  }

  get done(): boolean {
    return this.doneFlag;
  }

  get tree(): DiscoveryTree {
    const idx = new TreeIndex(this.currentTree());
    return {
      ...this.currentTree(),
      nodes: idx.nodes
    };
  }

  currentTree(): DiscoveryTree {
    return this.index.tree;
  }

  observed(): ReadonlyMap<string, Observation> {
    return this.observations;
  }

  legalActions(): string[] {
    if (this.doneFlag) return [];
    const revealed = new Set(this.observations.keys());
    const parents = new Set<string>();
    for (const obs of this.observations.values()) {
      if (obs.parentId !== ROOT_ID) parents.add(obs.parentId);
    }
    const leaves: string[] = [];
    for (const id of revealed) {
      if (parents.has(id)) continue;
      const hasChild = this.index.children(id).some((c) => revealed.has(c.id));
      if (!hasChild) leaves.push(id);
    }
    return [ROOT_ID, ...leaves];
  }

  legalRoots(): number {
    return Number.POSITIVE_INFINITY;
  }

  openedBranches(): number[] {
    const out = new Set<number>();
    for (const obs of this.observations.values()) out.add(obs.branch);
    return [...out];
  }

  priorHistory(): ReadonlyArray<TreeSummary> {
    return this.cfg.priorHistory;
  }

  validateBatch(ids: string[]): void {
    if (this.doneFlag) throw new Error("live rollout already done");
    if (ids.length > this.maxParallelism) {
      throw new Error(`batch size ${ids.length} exceeds maxParallelism ${this.maxParallelism}`);
    }
    const legal = new Set(this.legalActions());
    const seen = new Set<string>();
    for (const id of ids) {
      if (!legal.has(id)) throw new Error(`non-eligible id ${id}`);
      if (id === ROOT_ID) continue;
      if (seen.has(id)) throw new Error(`duplicate leaf ${id}`);
      seen.add(id);
    }
  }

  async probeBatch(ids: string[]): Promise<Observation[]> {
    this.validateBatch(ids);
    if (ids.length === 0) {
      this.doneFlag = true;
      return [];
    }
    const prepared: Awaited<ReturnType<LiveEnv["prepare"]>>[] = [];
    for (const id of ids) prepared.push(await this.prepare(id));
    const results = await Promise.all(prepared.map((p) => this.execute(p)));
    this.roundsUsed += 1;
    this.batches.push([...ids]);
    for (const node of results) this.index.nodes.push(node);
    for (const node of results) {
      const parentScore =
        node.parentId === ROOT_ID ? null : (this.index.get(node.parentId)?.score ?? null);
      this.observations.set(node.id, toObservation(node, this.baselineScore, parentScore));
    }
    if (this.roundsUsed >= this.roundsLimit) this.doneFlag = true;
    if (this.cfg.onTreeChange) await this.cfg.onTreeChange(this.currentTree());
    if (this.cfg.onRound) await this.cfg.onRound(this.currentTree(), [...ids]);
    return results.map(
      (node) =>
        this.observations.get(node.id) as Observation
    );
  }

  batchesTaken(): string[][] {
    return this.batches.map((b) => [...b]);
  }

  get rounds(): number {
    return this.roundsUsed;
  }

  get calls(): number {
    return this.agentCalls;
  }

  summary(): TreeSummary {
    return summarizeTree(this.currentTree(), this.batches, this.roundsUsed);
  }

  private async prepare(id: string): Promise<{
    id: string;
    parent: DiscoveryNode | null;
    branch: number;
    attempt: number;
    seq: number;
    snapshotRef: string;
  }> {
    const target = id === ROOT_ID ? null : this.index.get(id) ?? null;
    const branch = target ? target.branch : this.reserveBranch();
    const attempt = target ? target.attempt + 1 : 0;
    const nodeId = target ? `${target.id}.${attempt}` : `b${branch}a${attempt}`;
    const snapshotRef = target ? target.snapshotRef : await this.cfg.workspace.rootSnapshotRef();
    return {
      id: nodeId,
      parent: target,
      branch,
      attempt,
      seq: this.seq++,
      snapshotRef
    };
  }

  private nextBranchId = 0;

  private reserveBranch(): number {
    let max = this.nextBranchId - 1;
    for (const node of this.index.nodes) max = Math.max(max, node.branch);
    const branch = max + 1;
    this.nextBranchId = branch + 1;
    return branch;
  }

  private async execute(prep: {
    id: string;
    parent: DiscoveryNode | null;
    branch: number;
    attempt: number;
    seq: number;
    snapshotRef: string;
  }): Promise<DiscoveryNode> {
    const start = Date.now();
    const worktreeName = `${this.cfg.runId}-t${this.cfg.treeIndex}-${prep.seq}-${randomUUID().slice(0, 8)}`;
    const worktreeDir = await this.cfg.workspace.createWorktree(worktreeName, prep.snapshotRef);
    this.agentCalls += 1;
    let score: number | null = null;
    let valid = false;
    let failClass: string = "agent_error";
    let error: string | null = null;
    let diagnostics: unknown = null;
    let tokens: number | undefined;
    try {
      const ancestorPath: Observation[] = [];
      let cursor = prep.parent;
      while (cursor) {
        const obs = this.observations.get(cursor.id);
        if (obs) ancestorPath.unshift(obs);
        cursor = cursor.parentId === ROOT_ID ? null : this.index.get(cursor.parentId) ?? null;
      }
      const context: AgentContext = {
        nodeId: prep.id,
        branch: prep.branch,
        attempt: prep.attempt,
        ancestorPath,
        taskPrompt: this.cfg.task.prompt
      };
      const agentOut = await withTimeout(
        this.cfg.agent.run({
          workspaceDir: worktreeDir,
          task: this.cfg.task,
          parent: prep.parent,
          context
        }),
        this.cfg.task.agentTimeoutMs,
        "agent"
      );
      tokens = agentOut.tokens;
      const evalOut = await this.cfg.evaluator.evaluate(worktreeDir);
      score = evalOut.score;
      valid = evalOut.valid;
      failClass = evalOut.failClass;
      error = evalOut.error;
      diagnostics = evalOut.diagnostics;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failClass = message.includes("timed out") ? "timeout" : "agent_error";
      error = message;
    }
    // Always clean up the worktree, even if committing fails. A leaked
    // worktree blocks its branch name on the next attempt and eventually
    // exhausts the repo's worktree list.
    let snapshotRef: string;
    try {
      snapshotRef = await this.cfg.workspace.commitWorkspace(
        worktreeDir,
        `node ${prep.id} (score=${score ?? "null"})`
      );
    } finally {
      await this.cfg.workspace.removeWorktree(worktreeDir);
    }
    return {
      id: prep.id,
      parentId: prep.parent ? prep.parent.id : ROOT_ID,
      branch: prep.branch,
      attempt: prep.attempt,
      seq: prep.seq,
      score,
      valid,
      failClass,
      error,
      diagnostics,
      snapshotRef,
      artifactPath: null,
      cost: {
        agentCalls: 1,
        wallMs: Date.now() - start,
        tokens
      },
      createdAt: new Date().toISOString()
    };
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

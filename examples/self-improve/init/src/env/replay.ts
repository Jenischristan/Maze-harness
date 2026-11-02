import { TreeIndex, ROOT_ID, toObservation } from "../tree.js";
import type {
  DiscoveryTree,
  ExplorationEnv,
  Observation,
  TreeSummary
} from "../types.js";

export class IllegalBatchError extends Error {}

export interface ReplayOptions {
  maxRounds?: number;
}

export interface ReplayTrace {
  batches: string[][];
  rounds: number;
  revealed: Observation[];
  done: boolean;
  error: string | null;
  illegal: boolean;
}

export interface ReplayEnvOptions {
  maxRounds?: number;
  priorHistory?: ReadonlyArray<TreeSummary>;
}

export class ReplayEnv implements ExplorationEnv {
  readonly baselineScore: number;
  readonly maxParallelism: number;
  readonly maxRounds: number;

  private readonly index: TreeIndex;
  private readonly defaultSnapshot: string;
  private readonly revealedSet = new Set<string>();
  private readonly observations = new Map<string, Observation>();
  private readonly history: ReadonlyArray<TreeSummary>;
  private readonly batches: string[][] = [];
  private roundsUsed = 0;
  private doneFlag = false;
  private scoreOfRoot: number | null = null;

  constructor(tree: DiscoveryTree, opts: ReplayEnvOptions = {}) {
    this.index = new TreeIndex(tree);
    this.baselineScore = tree.baselineScore;
    this.maxParallelism = Math.max(1, tree.maxParallelism);
    this.maxRounds = Math.max(0, opts.maxRounds ?? tree.roundsLimit);
    this.defaultSnapshot = "root";
    this.history = opts.priorHistory ?? [];
  }

  get roundsRemaining(): number {
    return this.doneFlag ? 0 : Math.max(0, this.maxRounds - this.roundsUsed);
  }

  get done(): boolean {
    return this.doneFlag;
  }

  observed(): ReadonlyMap<string, Observation> {
    return this.observations;
  }

  legalActions(): string[] {
    if (this.doneFlag) return [];
    const leaves = this.index.leaves(this.revealedSet);
    return [ROOT_ID, ...leaves.map((n) => n.id)];
  }

  legalRoots(): number {
    return this.index.nodes.filter(
      (n) => n.parentId === ROOT_ID && !this.revealedSet.has(n.id)
    ).length;
  }

  openedBranches(): number[] {
    return this.index.nodes.map((n) => n.branch);
  }

  priorHistory(): ReadonlyArray<TreeSummary> {
    return this.history;
  }

  batchesTaken(): string[][] {
    return this.batches.map((b) => [...b]);
  }

  get rounds(): number {
    return this.roundsUsed;
  }

  revealedObservations(): Observation[] {
    return [...this.observations.values()];
  }

  validateBatch(ids: string[]): void {
    if (this.doneFlag) throw new IllegalBatchError("replay already done");
    if (!Array.isArray(ids)) throw new IllegalBatchError("batch must be an array");
    if (ids.length > this.maxParallelism) {
      throw new IllegalBatchError(
        `batch size ${ids.length} exceeds maxParallelism ${this.maxParallelism}`
      );
    }
    const legal = new Set(this.legalActions());
    const seenLeaves = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || !legal.has(id)) {
        throw new IllegalBatchError(`non-eligible id ${String(id)}`);
      }
      if (id === ROOT_ID) continue;
      if (seenLeaves.has(id)) throw new IllegalBatchError(`duplicate leaf ${id}`);
      seenLeaves.add(id);
    }
    if (this.legalRoots() <= 0) {
      const roots = ids.filter((id) => id === ROOT_ID).length;
      if (roots > 0) {
        throw new IllegalBatchError("no unrevealed root children left to open");
      }
    }
    if (ids.length === 0) return;
  }

  async probeBatch(ids: string[]): Promise<Observation[]> {
    this.validateBatch(ids);
    if (ids.length === 0) {
      this.doneFlag = true;
      return [];
    }
    const out: Observation[] = [];
    for (const id of ids) {
      if (id === ROOT_ID) {
        const next = this.index.firstUnrevealedRootChild(this.revealedSet);
        if (next) out.push(this.reveal(next));
        continue;
      }
      const child = this.index.latestChild(id);
      if (child && !this.revealedSet.has(child.id)) out.push(this.reveal(child));
    }
    this.roundsUsed += 1;
    this.batches.push([...ids]);
    if (this.roundsUsed >= this.maxRounds) this.doneFlag = true;
    if (this.fullyRevealed() && this.noLegalContinuation()) this.doneFlag = true;
    return out;
  }

  private fullyRevealed(): boolean {
    return this.revealedSet.size >= this.index.nodes.length;
  }

  private noLegalContinuation(): boolean {
    return this.legalActions().length <= 1 && this.legalRoots() <= 0;
  }

  private reveal(node: { id: string }): Observation {
    const full = this.index.get(node.id);
    if (!full) throw new IllegalBatchError(`unknown node ${node.id}`);
    const parentScore =
      full.parentId === ROOT_ID
        ? this.scoreOfRoot
        : (this.index.get(full.parentId)?.score ?? null);
    const obs = toObservation(full, this.baselineScore, parentScore);
    this.revealedSet.add(full.id);
    this.observations.set(full.id, obs);
    return obs;
  }
}

export function replayTrace(env: ReplayEnv): ReplayTrace {
  return {
    batches: env.batchesTaken(),
    rounds: env.rounds,
    revealed: env.revealedObservations(),
    done: env.done,
    error: null,
    illegal: false
  };
}

export function makeReplayEnv(
  tree: DiscoveryTree,
  opts: ReplayEnvOptions = {}
): ReplayEnv {
  return new ReplayEnv(tree, opts);
}

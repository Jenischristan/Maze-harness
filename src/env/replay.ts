import { TreeIndex, ROOT_ID, toObservation, withBranchSignals } from "../tree.js";
import type { DiscoveryTree, ExplorationEnv, Observation, TreeSummary } from "../types.js";

export class IllegalBatchError extends Error {}

interface ReplayOptions {
  maxRounds?: number;
}

interface ReplayTrace {
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

  /** Best revealed score, or the baseline when nothing was revealed. */
  get bestSoFar(): number | null {
    let best: number | null = null;
    for (const obs of this.observations.values()) {
      if (obs.score === null) continue;
      if (best === null || obs.score > best) best = obs.score;
    }
    return best ?? this.baselineScore;
  }

  /** Number of probes spent so far (revealed non-root nodes). */
  get budgetSpent(): number {
    return this.observations.size;
  }

  /**
   * Reset the observed prefix to just the root. The full recorded tree is
   * untouched, so replay can start a fresh rollout over the same world.
   */
  reset(): void {
    this.revealedSet.clear();
    this.observations.clear();
    this.batches.length = 0;
    this.roundsUsed = 0;
    this.doneFlag = false;
  }

  meta(id: string): import("../types.js").CellMeta {
    const node = id === ROOT_ID ? null : this.index.get(id);
    return {
      id,
      branch: node?.branch ?? -1,
      attempt: node?.attempt ?? 0,
      parentId: node?.parentId ?? "",
      seq: node?.seq ?? -1,
      tags: id === ROOT_ID ? ["root"] : []
    };
  }

  legalActions(): string[] {
    if (this.doneFlag) return [];
    const leaves = this.index.leaves(this.revealedSet);
    return [ROOT_ID, ...leaves.map((n) => n.id)];
  }

  legalRoots(): number {
    return this.index.nodes.filter((n) => n.parentId === ROOT_ID && !this.revealedSet.has(n.id))
      .length;
  }

  openedBranches(): number[] {
    // Match LiveEnv: only branches the policy observed. Returning every branch
    // leaked future tree structure.
    const out = new Set<number>();
    for (const obs of this.observations.values()) out.add(obs.branch);
    return [...out];
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
    // An empty batch ends the rollout; check it before any root-availability
    // rule so the intent is unambiguous.
    if (ids.length === 0) return;
    if (this.legalRoots() <= 0) {
      const roots = ids.filter((id) => id === ROOT_ID).length;
      if (roots > 0) {
        throw new IllegalBatchError("no unrevealed root children left to open");
      }
    }
    // An empty tree has no recorded children at all: opening a root can never
    // reveal anything, so a batch of roots must be rejected exactly like the
    // "no unrevealed root children" case rather than counted as a no-op round.
    if (this.index.nodes.length === 0 && ids.length > 0) {
      throw new IllegalBatchError("tree has no recorded nodes to reveal");
    }
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
      // A legal leaf whose recorded child is already revealed (or which has no
      // recorded child at all) is a legitimate no-op probe: a live rollout can
      // end on such a leaf, and replay must follow that trace exactly. The
      // round is still counted, the batch still recorded. Only an id that is
      // not a leaf can get here, and `validateBatch` rejects those first.
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
    // The root's score is the tree baseline (paper: the root is the initial
    // workspace, scored once as `baselineScore`). Passing it explicitly keeps a
    // root child's parent delta measured against the root instead of relying on
    // `toObservation`'s fallback and a never-assigned `scoreOfRoot`.
    const parentScore =
      full.parentId === ROOT_ID
        ? this.baselineScore
        : (this.index.get(full.parentId)?.score ?? null);
    const obs = withBranchSignals(
      toObservation(full, this.baselineScore, parentScore),
      this.branchObservations(full.branch, full.id)
    );
    this.revealedSet.add(full.id);
    this.observations.set(full.id, obs);
    return obs;
  }

  /** Revealed observations on one branch, excluding the just-revealed cell. */
  private branchObservations(branch: number, excludeId: string): Observation[] {
    const out: Observation[] = [];
    for (const obs of this.observations.values()) {
      if (obs.branch === branch && obs.id !== excludeId) out.push(obs);
    }
    return out;
  }
}

function replayTrace(env: ReplayEnv): ReplayTrace {
  return {
    batches: env.batchesTaken(),
    rounds: env.rounds,
    revealed: env.revealedObservations(),
    done: env.done,
    error: null,
    illegal: false
  };
}

function makeReplayEnv(tree: DiscoveryTree, opts: ReplayEnvOptions = {}): ReplayEnv {
  return new ReplayEnv(tree, opts);
}

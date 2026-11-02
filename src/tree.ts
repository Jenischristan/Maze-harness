import type {
  DiscoveryNode,
  DiscoveryTree,
  Observation,
  TreeSummary
} from "./types.js";

export const ROOT_ID = "root";

class TreeError extends Error {}

export class TreeIndex {
  readonly tree: DiscoveryTree;
  private readonly byId = new Map<string, DiscoveryNode>();
  private readonly childrenOf = new Map<string, DiscoveryNode[]>();
  private readonly rootChildren: DiscoveryNode[] = [];

  constructor(tree: DiscoveryTree) {
    this.tree = tree;
    const ordered = [...tree.nodes].sort((a, b) => a.seq - b.seq);
    for (const node of ordered) {
      if (node.id === ROOT_ID) throw new TreeError("non-root node cannot use id 'root'");
      if (this.byId.has(node.id)) throw new TreeError(`duplicate node id ${node.id}`);
      this.byId.set(node.id, node);
      const list = this.childrenOf.get(node.parentId) ?? [];
      list.push(node);
      this.childrenOf.set(node.parentId, list);
      if (node.parentId === ROOT_ID) this.rootChildren.push(node);
    }
    this.rootChildren.sort((a, b) => a.seq - b.seq);
  }

  get nodes(): DiscoveryNode[] {
    return this.tree.nodes;
  }

  get(id: string): DiscoveryNode | undefined {
    return this.byId.get(id);
  }

  children(id: string): DiscoveryNode[] {
    if (id === ROOT_ID) return this.rootChildren;
    return this.childrenOf.get(id) ?? [];
  }

  latestChild(id: string): DiscoveryNode | undefined {
    const list = this.childrenOf.get(id);
    if (!list || list.length === 0) return undefined;
    return list.reduce((best, n) => (n.seq > best.seq ? n : best));
  }

  firstUnrevealedRootChild(revealed: ReadonlySet<string>): DiscoveryNode | undefined {
    return this.rootChildren.find((n) => !revealed.has(n.id));
  }

  leaves(revealed: ReadonlySet<string>): DiscoveryNode[] {
    return this.tree.nodes.filter(
      (n) => revealed.has(n.id) && this.children(n.id).filter((c) => revealed.has(c.id)).length === 0
    );
  }

  isRevealed(id: string, revealed: ReadonlySet<string>): boolean {
    return id === ROOT_ID || revealed.has(id);
  }

  ancestors(id: string): DiscoveryNode[] {
    const out: DiscoveryNode[] = [];
    let cur = this.byId.get(id);
    while (cur) {
      out.push(cur);
      if (cur.parentId === ROOT_ID) break;
      cur = this.byId.get(cur.parentId);
      if (!cur) break;
    }
    return out.reverse();
  }

  snapshotRefOf(id: string, fallback: string): string {
    if (id === ROOT_ID) return fallback;
    return this.byId.get(id)?.snapshotRef ?? fallback;
  }
}

export function toObservation(
  node: DiscoveryNode,
  baseline: number,
  parentScore: number | null
): Observation {
  const scale = Math.max(Math.abs(baseline), 1);
  const diag = node.diagnostics;
  const counts = readValidCounts(diag);
  return {
    id: node.id,
    branch: node.branch,
    attempt: node.attempt,
    parentId: node.parentId,
    seq: node.seq,
    score: node.score,
    valid: node.valid,
    failClass: node.failClass,
    error: node.error,
    deltaVsBaseline: node.score === null ? null : (node.score - baseline) / scale,
    deltaVsParent:
      node.score === null || parentScore === null ? null : (node.score - parentScore) / scale,
    nValid: counts.nValid,
    nTotal: counts.nTotal,
    tags: counts.tags,
    branchPromising: false,
    branchFailedHard: false,
    improvedVsParent: node.score !== null && parentScore !== null && node.score > parentScore,
    improvedVsBaseline: node.score !== null && node.score > baseline
  };
}

/**
 * Derive the paper's `see.policy.observation_signal` helpers from the revealed
 * prefix of one branch:
 *
 *   branch_promising        a successful probe with error === null and
 *                           fail_class === "ok" raised the score over parent
 *                           (or over baseline for a root child);
 *   branch_failed_hard      at least two same-class failures and no successful
 *                           probe anywhere earlier on the branch;
 *   probe_improved_vs_parent / probe_improved_vs_baseline  the per-cell deltas.
 *
 * Success semantics follow the paper: a successful evaluation is one with
 * `error === null` and `fail_class === "ok"`, even when `valid` is false.
 */
export function withBranchSignals(
  obs: Observation,
  earlierOnBranch: ReadonlyArray<Observation>
): Observation {
  const successful = (o: Observation): boolean => o.error === null && o.failClass === "ok";
  const improved = (o: Observation): boolean =>
    successful(o) &&
    ((o.deltaVsParent !== null && o.deltaVsParent > 0) ||
      (o.deltaVsBaseline !== null && o.deltaVsBaseline > 0));
  const priorSuccess = earlierOnBranch.some(successful);
  const sameClassFailures = earlierOnBranch.filter(
    (o) => !successful(o) && o.failClass === obs.failClass
  ).length;
  return {
    ...obs,
    branchPromising: improved(obs) || earlierOnBranch.some(improved),
    branchFailedHard: !successful(obs) && sameClassFailures >= 1 && !priorSuccess,
    improvedVsParent: obs.deltaVsParent !== null && obs.deltaVsParent > 0,
    improvedVsBaseline: obs.deltaVsBaseline !== null && obs.deltaVsBaseline > 0
  };
}

/**
 * Pull prefix-safe counters out of evaluator diagnostics without assuming a
 * shape: `n_valid`/`nValid` and `n_total`/`nTotal` are recognised, and any
 * `tags` array of strings is passed through.
 */
function readValidCounts(diag: unknown): {
  nValid: number | null;
  nTotal: number | null;
  tags: string[];
} {
  if (!diag || typeof diag !== "object") return { nValid: null, nTotal: null, tags: [] };
  const d = diag as Record<string, unknown>;
  const nValid = firstInt(d.n_valid, d.nValid);
  const nTotal = firstInt(d.n_total, d.nTotal);
  const rawTags = d.tags;
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((t): t is string => typeof t === "string")
    : [];
  return { nValid, nTotal, tags };
}

function firstInt(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

export function summarizeTree(
  tree: DiscoveryTree,
  batches: string[][],
  roundsUsed: number
): TreeSummary {
  const branches = new Set(tree.nodes.map((n) => n.branch));
  let best: number | null = null;
  for (const n of tree.nodes) {
    if (n.score === null) continue;
    if (best === null || n.score > best) best = n.score;
  }
  return {
    treeIndex: tree.treeIndex,
    baselineScore: tree.baselineScore,
    maxParallelism: tree.maxParallelism,
    roundsUsed,
    nodeCount: tree.nodes.length,
    branches: branches.size,
    bestScore: best,
    batches
  };
}

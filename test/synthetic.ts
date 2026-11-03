import type { DiscoveryNode, DiscoveryTree } from "../src/types.js";
import { ROOT_ID } from "../src/tree.js";

export interface Mulberry32 {
  (): number;
}

export function mulberry32(seed: number): Mulberry32 {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticTreeOptions {
  seed: number;
  branches: number;
  refinements: number;
  baselineScore?: number;
  maxParallelism?: number;
  roundsLimit?: number;
  failRate?: number;
  branchDrift?: number;
  nodeNoise?: number;
  dominantBranch?: number;
  dominantBoost?: number;
}

function idFor(branch: number, attempt: number): string {
  return `b${branch}a${attempt}`;
}

export function syntheticTree(opts: SyntheticTreeOptions): DiscoveryTree {
  const rnd = mulberry32(opts.seed);
  const baseline = opts.baselineScore ?? 0.5;
  const failRate = opts.failRate ?? 0.15;
  const drift = opts.branchDrift ?? 0.1;
  const noise = opts.nodeNoise ?? 0.08;
  const nodes: DiscoveryNode[] = [];
  let seq = 0;
  const now = new Date(0).toISOString();
  for (let b = 0; b < opts.branches; b += 1) {
    let branchBase = baseline + (rnd() - 0.35) * drift;
    if (opts.dominantBranch === b) branchBase += opts.dominantBoost ?? 1.0;
    let parentScore: number | null = baseline;
    let parentId = ROOT_ID;
    for (let a = 0; a < opts.refinements; a += 1) {
      const failed = rnd() < failRate;
      const failureClass = failed
        ? (["compile", "runtime", "timeout", "incorrect"] as const)[Math.floor(rnd() * 4)]!
        : "ok";
      const step = (rnd() - 0.25) * noise;
      const rawScore = failed ? null : branchBase + a * 0.05 + step;
      const score = rawScore === null ? null : Number(rawScore.toFixed(6));
      const node: DiscoveryNode = {
        id: idFor(b, a),
        parentId,
        branch: b,
        attempt: a,
        seq: seq++,
        score,
        valid: !failed,
        failClass: failureClass,
        error: failed ? `synthetic ${failureClass}` : null,
        diagnostics: { synthetic: true },
        snapshotRef: idFor(b, a),
        artifactPath: null,
        cost: { agentCalls: 1, wallMs: 1000 },
        createdAt: now
      };
      nodes.push(node);
      parentId = node.id;
      parentScore = score;
    }
  }
  return {
    runId: `synthetic-${opts.seed}`,
    treeIndex: opts.seed,
    baselineScore: baseline,
    maxParallelism: opts.maxParallelism ?? 4,
    roundsLimit: opts.roundsLimit ?? 12,
    policyId: "synthetic",
    nodes,
    createdAt: now
  };
}

import { ReplayEnv } from "../env/replay.js";
import { scoreReplay } from "../score.js";
import type { DiscoveryTree, ExplorationPolicy, ReplayReport, ReplayScoreConfig, TreeSummary } from "../types.js";

interface Payload {
  bundlePath: string;
  tree: DiscoveryTree;
  priorHistory: TreeSummary[];
  policyId: string;
  scoreConfig: ReplayScoreConfig;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function failed(tree: DiscoveryTree, policyId: string, error: string, illegal: boolean): ReplayReport {
  return {
    treeIndex: tree.treeIndex,
    policyId,
    score: Number.NEGATIVE_INFINITY,
    best: tree.baselineScore,
    n: 0,
    k: 0,
    batches: [],
    revealed: [],
    error,
    illegal,
    timedOut: false,
    wallMs: 0
  };
}

async function main(): Promise<void> {
  // Keep the child alive while an untrusted policy hangs. Without an active
  // handle, Node exits as soon as the pending promise stops holding the loop,
  // which would let a hang masquerade as a clean exit before the timeout fires.
  const keepAlive = setInterval(() => {}, 1 << 30);
  try {
    await run();
  } finally {
    clearInterval(keepAlive);
  }
}

async function run(): Promise<void> {
  const payload = JSON.parse(await readStdin()) as Payload;
  const env = new ReplayEnv(payload.tree, {
    maxRounds: payload.tree.roundsLimit,
    priorHistory: payload.priorHistory ?? []
  });
  let illegal = false;
  let error: string | null = null;
  try {
    const mod = (await import(payload.bundlePath)) as { default?: unknown };
    const Ctor = mod.default;
    if (typeof Ctor !== "function") {
      throw new Error("policy module must default-export a class");
    }
    const policy = new (Ctor as new (cfg: unknown) => ExplorationPolicy)({});
    if (!policy || typeof policy.solve !== "function") {
      throw new Error("policy instance must implement solve(env)");
    }
    await policy.solve(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    illegal = /non-eligible|duplicate leaf|exceeds maxParallelism|no unrevealed root/.test(message);
    error = message;
  }
  const report = error
    ? failed(payload.tree, payload.policyId, error, illegal)
    : scoreReplay(payload.tree, env, payload.policyId, payload.scoreConfig);
  process.stdout.write(`${JSON.stringify({ report, negativeInfinity: report.score === Number.NEGATIVE_INFINITY })}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err));
  process.exit(1);
});

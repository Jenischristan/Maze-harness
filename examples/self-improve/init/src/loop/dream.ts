import type {
  DiscoveryAgent,
  DiscoveryTree,
  Evaluator,
  PolicyDeveloper,
  ReplayScoreConfig,
  TaskSpec
} from "../types.js";
import { GitWorkspace } from "../workspace/git.js";
import { LiveEnv } from "../env/live.js";
import { runOnlineRollout } from "./online.js";
import { runOfflinePhase, type OfflineEvent } from "./offline.js";
import { RunStore } from "../runs/store.js";
import { compilePolicy } from "../policies/loader.js";
import { summaryFromTree } from "../runs/summary.js";
import { scoreReplay } from "../score.js";
import { ReplayEnv } from "../env/replay.js";

export interface DreamConfig {
  runId: string;
  repoDir: string;
  task: TaskSpec;
  agent: DiscoveryAgent;
  evaluator: Evaluator;
  developer: PolicyDeveloper;
  seedPolicy: { policyId: string; source: string };
  rounds: number;
  revisions: number;
  maxParallelism: number;
  roundsLimit: number;
  scoreConfig: ReplayScoreConfig;
  sandbox: { timeoutMs: number; memoryMb: number };
  holdoutLast?: boolean;
  mode: "dream" | "fixed";
  runRoot?: string;
  onEvent?: (event: DreamEvent) => void;
}

export type DreamEvent =
  | { type: "round-started"; round: number; policyId: string }
  | { type: "online-batch"; round: number; batch: string[]; nodes: number; best: number | null; tree: DiscoveryTree }
  | { type: "online-finished"; round: number; treeIndex: number; best: number | null; calls: number }
  | { type: "offline"; round: number; event: OfflineEvent }
  | {
      type: "round-finished";
      round: number;
      policyId: string;
      meanScore: number;
      holdoutScore: number | null;
      calls: number;
    };

export interface DreamResult {
  rounds: Array<{
    round: number;
    policyId: string;
    treeIndex: number;
    meanScore: number;
    holdoutScore: number | null;
    cumulativeCalls: number;
  }>;
}

export async function runDream(cfg: DreamConfig): Promise<DreamResult> {
  const runRoot = cfg.runRoot ?? "runs";
  const store = new RunStore({ rootDir: runRoot, runId: cfg.runId });
  await store.init();
  const workspace = new GitWorkspace({
    repoDir: cfg.repoDir,
    worktreesDir: `${cfg.repoDir}/worktrees`,
    initProgramDir: cfg.task.initProgramPath
  });
  await workspace.init();

  const rootRef = await workspace.rootSnapshotRef();
  const baselineDir = await workspace.createWorktree(`${cfg.runId}-baseline`, rootRef);
  const baseline = await cfg.evaluator.evaluate(baselineDir);
  await workspace.removeWorktree(baselineDir);
  const baselineScore = baseline.score ?? 0;

  let policyId = cfg.seedPolicy.policyId;
  let policySource = cfg.seedPolicy.source;
  const trees: DiscoveryTree[] = [];
  const histories = new Map<number, import("../types.js").TreeSummary[]>();
  const results: DreamResult["rounds"] = [];
  let cumulativeCalls = 0;

  for (let round = 1; round <= cfg.rounds; round += 1) {
    cfg.onEvent?.({ type: "round-started", round, policyId });
    const treeIndex = round - 1;
    const compiled = await compilePolicy({
      source: policySource,
      outDir: `${store.dir}/policies/build`,
      policyId: `${policyId}-t${round}`
    });
    if (!compiled.ok || !compiled.bundlePath) {
      throw new Error(`policy ${policyId} failed to compile for online rollout: ${compiled.error}`);
    }
    const policyModule = (await import(compiled.bundlePath)) as {
      default: new (cfg: unknown) => import("../types.js").ExplorationPolicy;
    };
    const policy = new policyModule.default({});
    const priorHistory = trees.map((t) => summaryFromTree(t));
    const env = new LiveEnv({
      runId: cfg.runId,
      treeIndex,
      baselineScore,
      maxParallelism: cfg.maxParallelism,
      roundsLimit: cfg.roundsLimit,
      policyId,
      task: cfg.task,
      agent: cfg.agent,
      evaluator: cfg.evaluator,
      workspace,
      priorHistory,
      onTreeChange: async (tree) => {
        await store.saveTree(tree);
      },
      onRound: async (tree, batch) => {
        cfg.onEvent?.({
          type: "online-batch",
          round,
          batch,
          nodes: tree.nodes.length,
          best: bestOf(tree),
          tree
        });
      }
    });
    await runOnlineRollout(env, policy);
    const tree = env.currentTree();
    if (tree.nodes.length === 0) {
      await store.saveTree(tree);
    }
    trees.push(tree);
    cumulativeCalls += env.calls;
    histories.set(treeIndex, priorHistory);
    let frozenMean = Number.NaN;
    if (cfg.mode === "fixed") {
      const replayed = await replayFromTree(tree, env.batchesTaken());
      frozenMean = scoreReplay(tree, replayed, policyId, cfg.scoreConfig).score;
    }
    cfg.onEvent?.({
      type: "online-finished",
      round,
      treeIndex,
      best: bestOf(tree),
      calls: cumulativeCalls
    });

    if (cfg.mode === "dream") {
      const useTrees = cfg.holdoutLast ? trees.slice(0, -1) : trees;
      const offline = await runOfflinePhase({
        round,
        currentPolicyId: policyId,
        currentPolicySource: policySource,
        trees,
        useTrees,
        histories,
        developer: cfg.developer,
        store,
        revisions: cfg.revisions,
        scoreConfig: cfg.scoreConfig,
        sandbox: cfg.sandbox,
        policyWorkDir: `${store.dir}/policies/work`,
        onEvent: (event) => cfg.onEvent?.({ type: "offline", round, event })
      });
      let meanScore = offline.selected.meanScore;
      let holdoutScore: number | null = null;
      if (cfg.holdoutLast) {
        const newest = trees.at(-1);
        if (newest) {
          const compiledNew = await compilePolicy({
            source: offline.selected.source,
            outDir: `${store.dir}/policies/build`,
            policyId: `${offline.selected.policyId}-holdout`
          });
          if (compiledNew.ok && compiledNew.bundlePath) {
            const { evaluatePolicyOnTrees } = await import("./offline.js");
            const { meanScore: mean } = await import("../score.js");
            const holdout = await evaluatePolicyOnTrees({
              policyId: `${offline.selected.policyId}-holdout`,
              bundlePath: compiledNew.bundlePath,
              trees: [newest],
              histories,
              scoreConfig: cfg.scoreConfig,
              sandbox: cfg.sandbox
            });
            holdoutScore = mean(holdout);
          }
        }
      }
      policyId = offline.selected.policyId;
      policySource = offline.selected.source;
      results.push({
        round,
        policyId,
        treeIndex,
        meanScore,
        holdoutScore,
        cumulativeCalls
      });
      cfg.onEvent?.({
        type: "round-finished",
        round,
        policyId,
        meanScore,
        holdoutScore,
        calls: cumulativeCalls
      });
    } else {
      results.push({
        round,
        policyId,
        treeIndex,
        meanScore: frozenMean,
        holdoutScore: null,
        cumulativeCalls
      });
      cfg.onEvent?.({
        type: "round-finished",
        round,
        policyId,
        meanScore: frozenMean,
        holdoutScore: null,
        calls: cumulativeCalls
      });
    }
    await store.saveState({
      runId: cfg.runId,
      round,
      policyId,
      policySource,
      cumulativeCalls,
      results
    });
  }
  return { rounds: results };
}

async function replayFromTree(
  tree: DiscoveryTree,
  batches: string[][]
): Promise<ReplayEnv> {
  const env = new ReplayEnv(tree, { maxRounds: tree.roundsLimit });
  for (const batch of batches) {
    if (env.done) break;
    try {
      await env.probeBatch(batch);
    } catch {
      break;
    }
  }
  return env;
}

function bestOf(tree: DiscoveryTree): number | null {
  let best: number | null = null;
  for (const node of tree.nodes) {
    if (node.score === null) continue;
    if (best === null || node.score > best) best = node.score;
  }
  return best;
}

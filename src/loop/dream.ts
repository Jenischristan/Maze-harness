import { join } from "node:path";
import type {
  DiscoveryAgent,
  DiscoveryTree,
  Evaluator,
  ExplorationPolicy,
  GridPlan,
  GridPlanningContext,
  PolicyDeveloper,
  ReplayScoreConfig,
  TaskSpec,
  TreeSummary
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
import {
  chooseDefaultBeta,
  loadBetaSweep,
  loadLiveManifests,
  manifestFromTree,
  saveLiveManifest,
  type BetaSweepPoint,
  type DefaultBetaDecision,
  type LiveCycleManifest
} from "./manifest.js";
import { RunLock, runLockPath } from "../util/lock.js";
import { getLogger } from "../util/logger.js";

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
  /** rho grid for offline selection; defaults to RHO_GRID. */
  scoreGrid?: readonly number[];
  sandbox: { timeoutMs: number; memoryMb: number };
  /** Abort signal (e.g. Ctrl-C); stops the rollout at the next boundary. */
  signal?: AbortSignal;
  holdoutLast?: boolean;
  mode: "dream" | "fixed";
  runRoot?: string;
  /**
   * Beta grid for the paper's evaluation-time sweep. `null` disables it and
   * selection falls back to the rho-grid mean.
   */
  betaGrid?: readonly number[] | null;
  /** Lambda in `pareto.reward = auc - lambda * parallel_penalty`. */
  paretoLambda?: number;
  /** Hard caps for the policy's next-cycle grid plan. */
  gridCaps?: { maxBranchCount: number; maxRefineCount: number };
  /**
   * Baked-in beta used for the first online cycle. Later cycles get their beta
   * from the paper's cross-cycle default-beta rule over live manifests; pass
   * `null` to disable beta selection entirely.
   */
  initialBeta?: number | null;
  /**
   * Continue a previously interrupted run from its last completed round.
   * Defaults to true; pass false to start over and overwrite the run state.
   */
  resume?: boolean;
  onEvent?: (event: DreamEvent) => void;
}

export type DreamEvent =
  | { type: "round-started"; round: number; policyId: string }
  | {
      type: "grid-planned";
      round: number;
      plan: { branchCount: number; refineCount: number; reason: string };
      source: "policy" | "fallback";
    }
  | { type: "beta-selected"; round: number; decision: DefaultBetaDecision }
  | {
      type: "online-batch";
      round: number;
      batch: string[];
      nodes: number;
      best: number | null;
      tree: DiscoveryTree;
    }
  | {
      type: "online-finished";
      round: number;
      treeIndex: number;
      best: number | null;
      calls: number;
    }
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

/**
 * Per-round facts that the *next* cycle's grid planner needs (paper Appendix
 * B.2: "history: completed earlier live manifests, including prior
 * planned/effective grids, actual opened width/depth, probe work, decision
 * rounds, scores, and beta"). These are captured at online time because the
 * tree alone does not record the plan the runner actually used, nor the beta
 * it was compiled with.
 */
export interface CycleHistory {
  tree: DiscoveryTree;
  plan: GridPlan;
  beta: number | null;
  rounds: number;
}

export async function runDream(cfg: DreamConfig): Promise<DreamResult> {
  const runRoot = cfg.runRoot ?? "runs";
  const log = getLogger("loop.dream", { runId: cfg.runId, mode: cfg.mode });
  const store = new RunStore({ rootDir: runRoot, runId: cfg.runId });
  await store.init();
  // Two runs sharing `runs/` raced on `_current`, manifest files and the
  // `policies/build/<id>.ts` sources, silently mixing two experiments' history.
  // One exclusive, PID-stamped lock per run root makes that impossible. The
  // lock is reclaimed automatically when its owner is gone.
  const lock = new RunLock({
    path: runLockPath(runRoot),
    runId: cfg.runId,
    onReclaim: (info, reason) =>
      log.warn("reclaimed stale run lock", { path: runLockPath(runRoot), pid: info?.pid, reason })
  });
  await lock.acquire();
  try {
    return await runDreamLocked(cfg, store, log);
  } finally {
    await lock.release();
  }
}

async function runDreamLocked(
  cfg: DreamConfig,
  store: RunStore,
  log: import("../util/logger.js").Logger
): Promise<DreamResult> {
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
  const cycleHistory: CycleHistory[] = [];
  const histories = new Map<number, import("../types.js").TreeSummary[]>();
  const results: DreamResult["rounds"] = [];
  let cumulativeCalls = 0;
  const manifestDir = join(store.dir, "reports");
  // Beta baked into the policy for the upcoming cycle. The first cycle uses
  // the caller's initial beta; later cycles follow the paper's cross-cycle
  // default-beta rule over the archived live manifests and sweeps.
  let bakedBeta: number | null = cfg.initialBeta ?? null;

  // Resume at the round boundary. A killed run previously restarted from
  // round 1, re-ran every discovery cycle and overwrote the earlier trees.
  // `state.json` is written after each completed round; the archived trees and
  // live manifests are the source of truth for the rounds already done.
  let startRound = 1;
  if (cfg.resume !== false) {
    const resumed = await resumeState(cfg, store, log);
    if (resumed) {
      startRound = resumed.round + 1;
      policyId = resumed.policyId;
      policySource = resumed.policySource;
      cumulativeCalls = resumed.cumulativeCalls;
      trees.push(...resumed.trees);
      results.push(...resumed.results);
      for (const tree of resumed.trees) {
        histories.set(tree.treeIndex, resumed.histories.get(tree.treeIndex) ?? []);
      }
      cycleHistory.push(...resumed.cycleHistory);
      bakedBeta = resumed.beta;
      log.info("resuming run at round boundary", {
        nextRound: startRound,
        completedRounds: resumed.round,
        calls: cumulativeCalls
      });
    }
  }

  for (let round = startRound; round <= cfg.rounds; round += 1) {
    if (cfg.signal?.aborted) break;
    cfg.onEvent?.({ type: "round-started", round, policyId });
    log.info("round started", { round, policyId });
    const treeIndex = round - 1;
    if (round > 1) {
      const manifests = await loadLiveManifests(manifestDir);
      const priorRound = manifests.at(-1);
      const sweep: BetaSweepPoint[] | null = priorRound
        ? await loadBetaSweep(manifestDir, priorRound.round, priorRound.policyId)
        : null;
      const decision = chooseDefaultBeta({ manifests, sweep, priorBeta: bakedBeta });
      bakedBeta = decision.beta;
      cfg.onEvent?.({ type: "beta-selected", round, decision });
    }
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
    // The grid planner is consulted on a probe instance first: `planGrid` runs
    // before a new live grid exists and must not see the cycle's outcomes. Its
    // plan is then handed to the policy that actually drives `solve()`, through
    // the constructor, so the plan is a hard bound in both live and replay.
    const planner = new policyModule.default(bakedBeta === null ? {} : { beta: bakedBeta });
    const priorHistory = trees.map((t) => summaryFromTree(t));

    const planned = await planGridForRound({
      policy: planner,
      round,
      history: cycleHistory,
      caps: cfg.gridCaps ?? {
        maxBranchCount: Math.max(1, cfg.maxParallelism),
        maxRefineCount: Math.max(0, cfg.roundsLimit)
      },
      workerCap: cfg.maxParallelism,
      onEvent: cfg.onEvent
    });
    const plan = planned.plan;
    const planSource = planned.source;
    const policyConfig: import("../types.js").PolicyConfig =
      bakedBeta === null ? { plan } : { beta: bakedBeta, plan };
    const policy = new policyModule.default(policyConfig);
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
      gridPlan: plan,
      signal: cfg.signal,
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
    // Live-cycle sidecar: what this cycle actually did, including the beta the
    // policy was compiled with. Later cycles read these (and the archived beta
    // sweeps) to choose their baked-in default beta.
    const onlineManifest = manifestFromTree({
      runId: cfg.runId,
      round,
      tree,
      policyId,
      plan,
      planSource: planSource,
      beta: bakedBeta,
      rounds: env.rounds
    });
    await saveLiveManifest(manifestDir, onlineManifest);
    cycleHistory.push({ tree, plan, beta: bakedBeta, rounds: env.rounds });

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
        scoreGrid: cfg.scoreGrid,
        betaGrid: cfg.betaGrid,
        paretoLambda: cfg.paretoLambda,
        // Replay under the same grid plan the online cycle was run with, so the
        // plan bounds the policy identically in live and replay.
        plan,
        sandbox: cfg.sandbox,
        policyWorkDir: `${store.dir}/policies/work`,
        onEvent: (event) => cfg.onEvent?.({ type: "offline", round, event })
      });
      const meanScore = offline.selected.meanScore;
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
              sandbox: cfg.sandbox,
              plan
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
      // Record the mode so `report` can classify a run without guessing from
      // its id; `--run-id` accepts any identifier.
      mode: cfg.mode,
      round,
      policyId,
      policySource,
      cumulativeCalls,
      results
    });
    log.info("round finished", {
      round,
      policyId,
      treeIndex,
      calls: cumulativeCalls,
      best: bestOf(tree)
    });
  }
  log.info("run finished", { rounds: results.length, calls: cumulativeCalls });
  return { rounds: results };
}

interface ResumedState {
  /** Last fully completed round, or 0 when nothing was recorded. */
  round: number;
  policyId: string;
  policySource: string;
  cumulativeCalls: number;
  trees: DiscoveryTree[];
  results: DreamResult["rounds"];
  histories: Map<number, import("../types.js").TreeSummary[]>;
  cycleHistory: CycleHistory[];
  beta: number | null;
}

/**
 * Reconstruct the loop state from a previous run's on-disk artifacts.
 *
 * A run writes `state.json` after every completed round, plus each tree under
 * `trees/` and a live manifest under `reports/`. `state.json` is the pointer to
 * "how far did we get"; the trees and manifests are re-read from disk so a
 * resumed run replays the *same* history the offline phase would have used,
 * rather than trusting a partially serialized copy.
 *
 * Returns null when there is nothing to resume (no state, or the run already
 * finished all its rounds, or the recorded state is unreadable).
 */
async function resumeState(
  cfg: DreamConfig,
  store: RunStore,
  log: import("../util/logger.js").Logger
): Promise<ResumedState | null> {
  const state = await store.loadState<{
    round?: unknown;
    policyId?: unknown;
    policySource?: unknown;
    cumulativeCalls?: unknown;
    results?: unknown;
  }>();
  if (!state) return null;
  const saved = state;
  const recordedRound = saved.round;
  if (typeof recordedRound !== "number" || !Number.isInteger(recordedRound)) return null;
  if (recordedRound < 1) return null;
  if (recordedRound >= cfg.rounds) {
    log.info("run already completed all requested rounds; nothing to resume", {
      completed: recordedRound,
      requested: cfg.rounds
    });
    return null;
  }
  const trees = await store.loadTrees();
  // Only keep the prefix that `recordedRound` actually completed, so a tree
  // written by an interrupted round is not counted twice.
  const completed = trees.filter((t) => t.treeIndex < recordedRound);
  if (completed.length !== recordedRound) {
    log.warn("resume state disagrees with archived trees; starting the incomplete round over", {
      completedRounds: recordedRound,
      archivedTrees: completed.length
    });
  }
  const manifests = await loadLiveManifests(join(store.dir, "reports"));
  const cycleHistory: CycleHistory[] = [];
  for (const tree of completed) {
    const manifest = manifests.find((m) => m.treeIndex === tree.treeIndex);
    const plan: GridPlan = manifest
      ? {
          branchCount: manifest.plannedBranchCount,
          refineCount: manifest.plannedRefineCount,
          reason: manifest.planReason
        }
      : {
          branchCount: Math.max(1, tree.nodes.filter((n) => n.parentId === "root").length),
          refineCount: Math.max(0, ...tree.nodes.map((n) => n.attempt)),
          reason: "resumed: plan reconstructed from the recorded tree"
        };
    cycleHistory.push({ tree, plan, beta: manifest?.beta ?? null, rounds: manifest?.rounds ?? 0 });
  }
  // Each tree's prior history is every tree before it, matching the live run.
  const histories = new Map<number, import("../types.js").TreeSummary[]>();
  for (const tree of completed) {
    histories.set(
      tree.treeIndex,
      completed.filter((t) => t.treeIndex < tree.treeIndex).map((t) => summaryFromTree(t))
    );
  }
  const last = completed.at(-1);
  const results = Array.isArray(saved.results)
    ? (saved.results as DreamResult["rounds"]).filter((r) => r && r.round <= recordedRound)
    : [];
  const lastManifest = manifests.find((m) => m.treeIndex === (last?.treeIndex ?? -1));
  return {
    round: recordedRound,
    policyId: typeof saved.policyId === "string" ? saved.policyId : cfg.seedPolicy.policyId,
    policySource:
      typeof saved.policySource === "string" ? saved.policySource : cfg.seedPolicy.source,
    cumulativeCalls:
      typeof saved.cumulativeCalls === "number" && Number.isFinite(saved.cumulativeCalls)
        ? saved.cumulativeCalls
        : 0,
    trees: completed,
    results,
    histories,
    cycleHistory,
    beta: lastManifest?.beta ?? cfg.initialBeta ?? null
  };
}

/**
 * Ask the current policy for its next-cycle grid plan (paper Appendix B.2
 * "Required next-cycle grid planning"). The plan always comes back non-null:
 * when the policy has no `planGrid`, returns an invalid plan, or throws, the
 * runtime falls back to a conservative bootstrap plan derived from the caps.
 * The returned plan is also clamped to the hard caps and worker cap so a
 * policy can never create a grid beyond what the runner supports.
 */
export async function planGridForRound(opts: {
  policy: ExplorationPolicy;
  round: number;
  /** Completed cycles with the plan/beta/rounds the runner actually used. */
  history: ReadonlyArray<CycleHistory>;
  caps: { maxBranchCount: number; maxRefineCount: number };
  workerCap: number;
  onEvent?: (event: DreamEvent) => void;
}): Promise<{ plan: GridPlan; source: "policy" | "fallback" }> {
  const hardMaxBranchCount = Math.max(1, Math.floor(opts.caps.maxBranchCount));
  const hardMaxRefineCount = Math.max(0, Math.floor(opts.caps.maxRefineCount));
  const workerCap = Math.max(1, Math.floor(opts.workerCap));
  const context: GridPlanningContext = {
    history: opts.history.map((entry) => {
      const tree = entry.tree;
      const branches = new Set(tree.nodes.map((n) => n.branch));
      let maxAttempt = 0;
      let best: number | null = null;
      for (const node of tree.nodes) {
        maxAttempt = Math.max(maxAttempt, node.attempt);
        if (node.score !== null && (best === null || node.score > best)) best = node.score;
      }
      return {
        round: tree.treeIndex + 1,
        // The actual plan used that cycle, not the runner's global caps: the
        // paper's planner reads "prior planned/effective grids".
        plannedBranchCount: entry.plan.branchCount,
        plannedRefineCount: entry.plan.refineCount,
        openedBranches: branches.size,
        maxAttempt,
        probes: tree.nodes.length,
        rounds: entry.rounds,
        bestScore: best,
        beta: entry.beta
      };
    }),
    fallbackBranchCount: Math.min(workerCap, hardMaxBranchCount),
    fallbackRefineCount: hardMaxRefineCount,
    hardMaxBranchCount,
    hardMaxRefineCount,
    workerCap,
    replaySupport: opts.history.map((entry) => {
      const tree = entry.tree;
      const rootChildren = tree.nodes.filter((n) => n.parentId === "root").length;
      let maxAttempt = 0;
      for (const node of tree.nodes) maxAttempt = Math.max(maxAttempt, node.attempt);
      return {
        traceBranchCount: Math.max(1, rootChildren),
        traceRefineCount: maxAttempt
      };
    })
  };

  const fallback: GridPlan = {
    branchCount: context.fallbackBranchCount,
    refineCount: context.fallbackRefineCount,
    reason:
      "bootstrap: policy provided no usable planGrid, so use the worker-capped fallback width/depth"
  };

  let plan: GridPlan = fallback;
  let source: "policy" | "fallback" = "fallback";
  try {
    if (typeof opts.policy.planGrid === "function") {
      const raw = await opts.policy.planGrid(context);
      const candidate = normalizePlan(raw, context);
      if (candidate) {
        plan = candidate;
        source = "policy";
      }
    }
  } catch {
    plan = fallback;
    source = "fallback";
  }
  opts.onEvent?.({ type: "grid-planned", round: opts.round, plan, source });
  return { plan, source };
}

/** Clamp an arbitrary policy plan into the context's hard bounds. */
function normalizePlan(
  raw: GridPlan | null | undefined,
  context: GridPlanningContext
): GridPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const branchCount = Number(raw.branchCount);
  const refineCount = Number(raw.refineCount);
  if (!Number.isFinite(branchCount) || !Number.isFinite(refineCount)) return null;
  const b = Math.min(context.hardMaxBranchCount, Math.max(1, Math.floor(branchCount)));
  const r = Math.min(context.hardMaxRefineCount, Math.max(0, Math.floor(refineCount)));
  const reason =
    typeof raw.reason === "string" && raw.reason.trim().length > 0
      ? raw.reason.trim()
      : "policy plan (no reason given)";
  return { branchCount: b, refineCount: r, reason };
}

async function replayFromTree(tree: DiscoveryTree, batches: string[][]): Promise<ReplayEnv> {
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

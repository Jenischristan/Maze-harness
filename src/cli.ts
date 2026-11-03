#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { runDream, type DreamEvent } from "./loop/dream.js";
import { seedPolicySource } from "./policies/seed.js";
import { ScriptedAgent } from "./agents/scripted.js";
import { CommandEvaluator } from "./evaluator.js";
import { DEFAULT_SCORE_CONFIG } from "./score.js";
import { makeProvider } from "./agent/provider.js";
import { DEFAULT_PERMISSION_POLICY, type PermissionPolicy } from "./tools/permissions.js";
import { versionFromCli } from "./cli-version.js";
import { parseCommandSpec } from "./util/args.js";
import { configureLoggingFromEnv } from "./util/logger.js";
import { resolveConfig } from "./config.js";
import type { ReplayScoreConfig, TaskSpec } from "./types.js";

const program = new Command();
program
  .name("maze-harness")
  .description("Dream-RSI-style recursive exploration-policy improvement harness")
  .version(await versionFromCli());

interface CommonOpts {
  runId?: string;
  rounds: string;
  revisions: string;
  workers: string;
  roundLimit: string;
  beta1: string;
  beta2: string;
  rho?: string;
  lambda?: string;
  grid?: string;
  betaGrid?: string;
  paretoLambda?: string;
  initialBeta?: string;
  maxBranches?: string;
  maxRefines?: string;
  normalize: string;
  sandboxTimeout: string;
  sandboxMemory: string;
  initDir: string;
  evaluator: string;
  evaluatorTimeout: string;
  agentTimeout: string;
  repo: string;
  runsDir: string;
  holdoutLast?: boolean;
  seed: string;
  agent: string;
  agentCommand: string;
  agentPromptMode: string;
  developer: string;
  developerCommand: string;
  developerPromptMode: string;
  developerPrompt: string;
  task: string;
  verify?: string[];
  permission: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: string;
  maxTurns: string;
  resume?: boolean;
  maxTokens?: string;
  maxWallMs?: string;
  maxUsd?: string;
  maxToolCalls?: string;
  logLevel?: string;
  logFormat?: string;
}

function parseScoreConfig(o: CommonOpts): ReplayScoreConfig {
  const cfg: ReplayScoreConfig = {
    beta1: Number(o.beta1),
    beta2: Number(o.beta2),
    normalize: o.normalize === "none" ? "none" : "relativeToBaseline"
  };
  // rho/lambda are opt-in: omitting the flags leaves them undefined so the
  // classic objective (best - beta1*N + beta2*N/k) is reproduced exactly.
  if (o.rho !== undefined && o.rho !== "" && Number.isFinite(Number(o.rho))) {
    cfg.rho = Number(o.rho);
  }
  if (o.lambda !== undefined && o.lambda !== "" && Number.isFinite(Number(o.lambda))) {
    cfg.lambda = Number(o.lambda);
  }
  return cfg;
}

/** Parse `--grid 0,0.25,0.5,1` into a rho grid; undefined keeps the default. */
function parseGrid(raw: string | undefined): readonly number[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const cells = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1);
  return cells.length > 0 ? cells : undefined;
}

/**
 * Parse `--initial-beta <n>`: a [0,1] scalar for the first live cycle, `off`
 * to disable cross-cycle beta selection (`null`), or undefined to let the
 * policy use its own default.
 */
function parseInitialBeta(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "off" || trimmed === "none") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    process.stderr.write(`invalid --initial-beta: ${raw} (expected a number in [0,1] or 'off')\n`);
    process.exit(2);
  }
  return n;
}

/**
 * Parse `--beta-grid 0,0.2,0.6,1` into a beta grid. `off`/`none` returns
 * `null` (sweep disabled). Undefined keeps the paper default.
 */
function parseBetaGrid(raw: string | undefined): readonly number[] | null | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed === "off" || trimmed === "none") return null;
  const cells = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1);
  return cells.length > 0 ? cells : undefined;
}

function parseTask(o: CommonOpts): TaskSpec {
  // `split(" ")` broke any evaluator path containing a space and left quote
  // characters in argv. `parseCommandSpec` accepts a shell-like string with
  // quoting or a JSON argv array, and never invokes a shell.
  let evaluatorCommand: string[];
  try {
    evaluatorCommand = parseCommandSpec(o.evaluator);
  } catch (err) {
    process.stderr.write(
      `invalid --evaluator: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(2);
  }
  return {
    name: "cli-task",
    description: "task supplied via CLI",
    prompt: o.task,
    initProgramPath: resolve(o.initDir),
    evaluatorCommand,
    evaluatorTimeoutMs: num("evaluator-timeout", o.evaluatorTimeout),
    agentTimeoutMs: num("agent-timeout", o.agentTimeout),
    verifyCommands: collectVerify(o)
  };
}

/**
 * Build the per-task budget from the optional `--max-*` flags. Omitted flags
 * leave the corresponding limit unset (no cap), so the default behaviour is
 * unchanged and a caller opts into each ceiling explicitly.
 */
function budgetFrom(o: CommonOpts): {
  maxTokens?: number;
  maxWallMs?: number;
  maxUsd?: number;
  maxToolCalls?: number;
} {
  const budget: {
    maxTokens?: number;
    maxWallMs?: number;
    maxUsd?: number;
    maxToolCalls?: number;
  } = {};
  if (o.maxTokens !== undefined) budget.maxTokens = positiveInt("max-tokens", o.maxTokens);
  if (o.maxWallMs !== undefined) budget.maxWallMs = positiveInt("max-wall-ms", o.maxWallMs);
  if (o.maxUsd !== undefined) budget.maxUsd = num("max-usd", o.maxUsd);
  if (o.maxToolCalls !== undefined) {
    budget.maxToolCalls = positiveInt("max-tool-calls", o.maxToolCalls);
  }
  return budget;
}

/** Parse a command flag that may be a quoted string or a JSON argv array. */
function commandFlag(name: string, raw: string): string[] {
  try {
    return parseCommandSpec(raw);
  } catch (err) {
    process.stderr.write(
      `invalid --${name}: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(2);
  }
}

function collectVerify(o: CommonOpts): string[] {
  const raw = o.verify ?? [];
  const out: string[] = [];
  for (const entry of raw) {
    for (const command of entry.split(";;")) {
      if (command.trim().length > 0) out.push(command.trim());
    }
  }
  return out;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Parse a required finite numeric flag. `--rounds abc` previously produced
 * `NaN`, and `for (round = 1; round <= NaN; ...)` silently ran zero rounds;
 * a `NaN` timeout disabled the timeout entirely. Fail fast with a clear
 * message instead.
 */
function num(name: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    process.stderr.write(`invalid --${name}: ${raw} (expected a number)\n`);
    process.exit(2);
  }
  return n;
}

/** Parse a numeric flag that must be positive. */
function positiveInt(name: string, raw: string | undefined): number {
  const n = num(name, raw);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(`invalid --${name}: ${raw} (expected a positive integer)\n`);
    process.exit(2);
  }
  return n;
}

/** Parse a numeric flag that must be a non-negative integer. */
function nonNegativeInt(name: string, raw: string | undefined): number {
  const n = num(name, raw);
  if (!Number.isInteger(n) || n < 0) {
    process.stderr.write(`invalid --${name}: ${raw} (expected a non-negative integer)\n`);
    process.exit(2);
  }
  return n;
}

function permissionPolicy(mode: string): PermissionPolicy {
  const action = mode === "ask" ? "ask" : mode === "deny" ? "deny" : "allow";
  return {
    ...DEFAULT_PERMISSION_POLICY,
    defaultAction: action,
    ask: async (input) => {
      // Fail closed when nothing can answer: a piped run has no TTY, and
      // blocking on stdin would hang the whole task instead of denying.
      if (!process.stdin.isTTY) {
        process.stderr.write(`permission denied (no TTY to ask): ${input.tool} ${input.pattern}\n`);
        return false;
      }
      process.stderr.write(`permission required: ${input.tool} ${input.pattern} [y/N] `);
      const answer = await readLine();
      return /^y(es)?$/i.test(answer.trim());
    }
  };
}

function readLine(): Promise<string> {
  return new Promise((resolvePromise) => {
    const onData = (chunk: Buffer | string): void => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolvePromise(chunk.toString());
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

function commonOptions(cmd: Command): Command {
  return cmd
    .option("--run-id <id>", "run identifier (default: random)")
    .option("--rounds <n>", "outer rounds T", "3")
    .option("--revisions <m>", "policy revisions per round M", "2")
    .option("--workers <w>", "max parallelism W", "3")
    .option("--round-limit <k>", "rounds per online rollout K1", "6")
    .option("--beta1 <n>", "probe penalty beta1", String(DEFAULT_SCORE_CONFIG.beta1))
    .option("--beta2 <n>", "parallelism bonus beta2", String(DEFAULT_SCORE_CONFIG.beta2))
    .option("--rho <n>", "budget preference rho in [0,1] (opt-in; grid-selected when omitted)")
    .option("--lambda <n>", "width penalty lambda applied to W = sum(batch-1) (default 0)")
    .option("--grid <list>", "comma-separated rho grid for selection (default 0,0.25,0.5,0.75,1)")
    .option(
      "--beta-grid <list>",
      "comma-separated beta grid for the evaluation-time sweep (default 0,0.2,0.4,0.6,0.8,1; 'off' disables)"
    )
    .option("--pareto-lambda <n>", "lambda in pareto.reward = auc - lambda*parallel_penalty", "0")
    .option(
      "--initial-beta <n>",
      "baked-in beta for the first live cycle (later cycles follow the live-manifest rule; 'off' disables beta selection)"
    )
    .option("--max-branches <n>", "hard cap on planned grid branches (default: --workers)")
    .option(
      "--max-refines <n>",
      "hard cap on planned refinements per branch (default: --round-limit)"
    )
    .option("--normalize <mode>", "relativeToBaseline | none", "relativeToBaseline")
    .option("--sandbox-timeout <ms>", "per policy-tree replay timeout", "5000")
    .option("--sandbox-memory <mb>", "per replay child memory limit", "256")
    .option("--init-dir <dir>", "initial workspace directory", "examples/toy-task/init")
    .option(
      "--evaluator <cmd>",
      "evaluator command; {workspace} is substituted",
      "python3 examples/toy-task/evaluator/evaluate.py {workspace}"
    )
    .option("--evaluator-timeout <ms>", "evaluator timeout", "20000")
    .option("--agent-timeout <ms>", "agent timeout", "20000")
    .option("--repo <dir>", "git workspace repo directory", "runs/_repo")
    .option("--runs-dir <dir>", "directory for run state", "runs")
    .option("--seed <n>", "deterministic scripted-agent seed", "1")
    .option("--holdout-last", "exclude newest tree from selection", false)
    .option("--no-resume", "start over instead of continuing a run at its last completed round")
    .option("--max-tokens <n>", "hard token budget per agent task (default: unlimited)")
    .option("--max-wall-ms <n>", "hard wall-clock budget per agent task in ms (default: unlimited)")
    .option("--max-usd <n>", "hard estimated USD budget per agent task (default: unlimited)")
    .option("--max-tool-calls <n>", "hard tool-call budget per agent task (default: unlimited)")
    .option(
      "--log-level <level>",
      "debug | info | warn | error (default: $DREAM_LOG_LEVEL or info)"
    )
    .option("--log-format <fmt>", "text | json (default: $DREAM_LOG_FORMAT or text)")
    .option("--agent <mode>", "discovery agent: scripted | cli | deepseek | tool", "scripted")
    .option("--agent-command <cmd>", "coding-agent CLI command (used with --agent cli)", "")
    .option("--agent-prompt-mode <mode>", "stdin | arg", "stdin")
    .option("--developer <mode>", "policy developer: fake | cli", "fake")
    .option(
      "--developer-command <cmd>",
      "policy-developer CLI command (used with --developer cli)",
      ""
    )
    .option("--developer-prompt-mode <mode>", "stdin | arg", "stdin")
    .option(
      "--developer-prompt <path>",
      "policy-developer prompt file",
      "prompts/policy-developer.md"
    )
    .option(
      "--task <text>",
      "task prompt given to the discovery agent",
      "Improve the program according to the evaluator."
    )
    .option(
      "--verify <cmd>",
      "verification command run after edits (repeatable; ';;' separates multiple)",
      collect,
      []
    )
    .option(
      "--permission <mode>",
      "allow | ask | deny for unmatched commands (default: ask, which fails closed without a TTY)",
      "ask"
    )
    .option("--model <name>", "model for the tool agent / chat", "deepseek-chat")
    .option(
      "--base-url <url>",
      "OpenAI-compatible endpoint",
      "http://127.0.0.1:8788/v1/chat/completions"
    )
    .option("--api-key <key>", "API key for the endpoint", "")
    .option("--context-window <n>", "model context window in tokens", "128000")
    .option("--max-turns <n>", "max agent turns per attempt", "40");
}

function makeToolProvider(o: CommonOpts) {
  return makeProvider({
    kind: "openai",
    baseUrl: o.baseUrl,
    apiKey: o.apiKey,
    model: o.model,
    contextWindow: Number(o.contextWindow)
  });
}

async function runLoop(mode: "dream" | "fixed", opts: CommonOpts): Promise<void> {
  // Logging is configured before anything can emit: flag > env > default.
  configureLoggingFromEnv(process.env);
  if (opts.logLevel !== undefined || opts.logFormat !== undefined) {
    const resolved = resolveConfig({ logLevel: opts.logLevel, logFormat: opts.logFormat });
    configureLoggingFromEnv({
      DREAM_LOG_LEVEL: resolved.logLevel,
      DREAM_LOG_FORMAT: resolved.logFormat
    });
  }
  const runId = opts.runId ?? `${mode}-${randomUUID().slice(0, 8)}`;
  const repoDir = resolve(opts.repo);
  await mkdir(repoDir, { recursive: true });
  const seed = await seedPolicySource("fixed");
  const task = parseTask(opts);
  const agent = await buildAgent(opts, task);
  const evaluator = new CommandEvaluator({
    command: task.evaluatorCommand,
    timeoutMs: task.evaluatorTimeoutMs
  });

  const log = (event: DreamEvent) => {
    if (event.type === "round-started") {
      process.stdout.write(`round ${event.round} policy=${event.policyId}\n`);
    } else if (event.type === "grid-planned") {
      process.stdout.write(
        `  round ${event.round} grid branches=${event.plan.branchCount} refines=${event.plan.refineCount} (${event.source}: ${event.plan.reason})\n`
      );
    } else if (event.type === "beta-selected") {
      process.stdout.write(
        `  round ${event.round} beta=${event.decision.beta} (${event.decision.source}: ${event.decision.reason})\n`
      );
    } else if (event.type === "online-batch") {
      process.stdout.write(
        `  round ${event.round} batch [${event.batch.join(", ")}] nodes=${event.nodes} best=${event.best ?? "null"}\n`
      );
    } else if (event.type === "round-finished") {
      process.stdout.write(
        `  round ${event.round} done policy=${event.policyId} calls=${event.calls}${
          Number.isFinite(event.meanScore) ? ` V=${event.meanScore.toFixed(4)}` : ""
        }${event.holdoutScore !== null ? ` holdout=${event.holdoutScore.toFixed(4)}` : ""}\n`
      );
    }
  };

  process.stdout.write(`[${mode}] run ${runId}\n`);
  const result = await runDream({
    runId,
    repoDir,
    task,
    agent,
    evaluator,
    developer: await buildDeveloper(opts),
    seedPolicy: seed,
    rounds: positiveInt("rounds", opts.rounds),
    // Zero revisions is meaningful: evaluate the incumbent only and select it.
    // `runOfflinePhase` already handles `revisions = 0` by looping zero times.
    revisions: nonNegativeInt("revisions", opts.revisions),
    maxParallelism: positiveInt("workers", opts.workers),
    roundsLimit: positiveInt("round-limit", opts.roundLimit),
    scoreConfig: parseScoreConfig(opts),
    scoreGrid: parseGrid(opts.grid),
    betaGrid: parseBetaGrid(opts.betaGrid),
    paretoLambda: num("pareto-lambda", opts.paretoLambda ?? "0"),
    initialBeta: parseInitialBeta(opts.initialBeta),
    gridCaps: {
      maxBranchCount:
        opts.maxBranches !== undefined
          ? positiveInt("max-branches", opts.maxBranches)
          : positiveInt("workers", opts.workers),
      maxRefineCount:
        opts.maxRefines !== undefined
          ? nonNegativeInt("max-refines", opts.maxRefines)
          : positiveInt("round-limit", opts.roundLimit)
    },
    sandbox: {
      timeoutMs: num("sandbox-timeout", opts.sandboxTimeout),
      memoryMb: num("sandbox-memory", opts.sandboxMemory)
    },
    holdoutLast: Boolean(opts.holdoutLast),
    resume: opts.resume !== false,
    mode,
    runRoot: resolve(opts.runsDir),
    onEvent: log
  });
  for (const r of result.rounds) {
    process.stdout.write(
      `round ${r.round}: policy=${r.policyId} best-calls=${r.cumulativeCalls} mean=${
        Number.isFinite(r.meanScore) ? r.meanScore.toFixed(4) : "n/a"
      }\n`
    );
  }
}

async function buildAgent(
  opts: CommonOpts,
  task: TaskSpec
): Promise<import("./types.js").DiscoveryAgent> {
  if (opts.agent === "tool") {
    const { ToolAgent } = await import("./agents/toolAgent.js");
    return new ToolAgent({
      provider: makeToolProvider(opts),
      verifyCommands: collectVerify(opts),
      runsDir: resolve(opts.runsDir),
      maxTurns: positiveInt("max-turns", opts.maxTurns),
      contextWindow: positiveInt("context-window", opts.contextWindow),
      permission: permissionPolicy(opts.permission),
      budget: budgetFrom(opts)
    });
  }
  if (opts.agent === "cli" || opts.agent === "deepseek") {
    const { CliAgent } = await import("./agents/cli.js");
    const command =
      opts.agent === "deepseek"
        ? [resolve("agents/deepseek-agent.mjs")]
        : commandFlag("agent-command", opts.agentCommand);
    if (command.length === 0) {
      throw new Error("--agent cli requires --agent-command");
    }
    return new CliAgent({
      command,
      promptMode: opts.agentPromptMode === "arg" ? "arg" : "stdin",
      timeoutMs: task.agentTimeoutMs,
      transcriptDir: resolve(opts.runsDir, "_transcripts")
    });
  }
  return new ScriptedAgent({ seed: num("seed", opts.seed), failRate: 0.1 });
}

async function buildDeveloper(opts: CommonOpts): Promise<import("./types.js").PolicyDeveloper> {
  if (opts.developer === "cli") {
    const { CliPolicyDeveloper } = await import("./developer/cli.js");
    if (!opts.developerCommand.trim()) {
      throw new Error("--developer cli requires --developer-command");
    }
    return new CliPolicyDeveloper({
      command: commandFlag("developer-command", opts.developerCommand),
      promptMode: opts.developerPromptMode === "arg" ? "arg" : "stdin",
      promptPath: resolve(opts.developerPrompt),
      workDir: resolve(opts.runsDir, "_developer")
    });
  }
  const { FakePolicyDeveloper } = await import("./developer/fake.js");
  const { loadVariantSource } = await import("./policies/seed.js");
  const greedy = await loadVariantSource("greedy");
  const fixed = await loadVariantSource("fixed");
  return new FakePolicyDeveloper({ variants: [greedy.source, fixed.source] });
}

commonOptions(program.command("dream").description("run the Dream-RSI loop")).action(
  async (_o: unknown, cmd: Command) => {
    await runLoop("dream", cmd.opts<CommonOpts>());
  }
);

commonOptions(program.command("fixed").description("run with a frozen policy")).action(
  async (_o: unknown, cmd: Command) => {
    await runLoop("fixed", cmd.opts<CommonOpts>());
  }
);

program
  .command("chat")
  .description("chat with the native tool agent in the current directory")
  .option("--message <text>", "message (otherwise taken from positional args)")
  .argument("[words...]", "message words")
  .option("--model <name>", "model", "deepseek-chat")
  .option(
    "--base-url <url>",
    "OpenAI-compatible endpoint",
    "http://127.0.0.1:8788/v1/chat/completions"
  )
  .option("--api-key <key>", "API key", "")
  .option("--context-window <n>", "context window", "128000")
  .option("--max-turns <n>", "max agent turns", "40")
  .option("--runs-dir <dir>", "directory for sessions", "runs")
  .option("--verify <cmd>", "verification command (repeatable)", collect, [])
  .option(
    "--permission <mode>",
    "allow | ask | deny (default: ask, fails closed without a TTY)",
    "ask"
  )
  .option("--max-tokens <n>", "hard token budget for the task")
  .option("--max-wall-ms <n>", "hard wall-clock budget in ms")
  .option("--max-usd <n>", "hard estimated USD budget")
  .option("--max-tool-calls <n>", "hard tool-call budget")
  .option("--log-level <level>", "debug | info | warn | error")
  .option("--log-format <fmt>", "text | json")
  .action(async (words: string[], o: Record<string, unknown>) => {
    configureLoggingFromEnv(process.env);
    if (o.logLevel !== undefined || o.logFormat !== undefined) {
      const resolved = resolveConfig({
        logLevel: o.logLevel === undefined ? undefined : String(o.logLevel),
        logFormat: o.logFormat === undefined ? undefined : String(o.logFormat)
      });
      configureLoggingFromEnv({
        DREAM_LOG_LEVEL: resolved.logLevel,
        DREAM_LOG_FORMAT: resolved.logFormat
      });
    }
    const { runChatOnce } = await import("./chat.js");
    const positional = Array.isArray(words) ? words.join(" ") : "";
    const message = String(o.message ?? positional);
    if (!message.trim()) {
      process.stderr.write("usage: maze-harness chat <message>\n");
      process.exit(1);
    }
    const budget: {
      maxTokens?: number;
      maxWallMs?: number;
      maxUsd?: number;
      maxToolCalls?: number;
    } = {};
    if (o.maxTokens !== undefined)
      budget.maxTokens = positiveInt("max-tokens", String(o.maxTokens));
    if (o.maxWallMs !== undefined)
      budget.maxWallMs = positiveInt("max-wall-ms", String(o.maxWallMs));
    if (o.maxUsd !== undefined) budget.maxUsd = num("max-usd", String(o.maxUsd));
    if (o.maxToolCalls !== undefined) {
      budget.maxToolCalls = positiveInt("max-tool-calls", String(o.maxToolCalls));
    }
    await runChatOnce({
      message,
      model: String(o.model),
      baseUrl: String(o.baseUrl),
      apiKey: String(o.apiKey),
      contextWindow: positiveInt("context-window", String(o.contextWindow)),
      maxTurns: positiveInt("max-turns", String(o.maxTurns)),
      runsDir: resolve(String(o.runsDir)),
      verifyCommands: (o.verify as string[]) ?? [],
      permission: String(o.permission),
      budget
    });
  });

program
  .command("report")
  .description("compare fixed vs dream runs: best score vs cumulative agent calls")
  .option("--runs-dir <dir>", "directory for run state", "runs")
  .option("--json", "emit JSON", false)
  .action(async (o: { runsDir: string; json?: boolean }) => {
    const { listRuns, renderComparison } = await import("./runs/report.js");
    const runs = await listRuns(resolve(o.runsDir));
    process.stdout.write(
      o.json ? `${JSON.stringify(runs, null, 2)}\n` : `${renderComparison(runs)}\n`
    );
  });

program
  .command("sessions")
  .description("list persisted agent sessions (newest first)")
  .option("--runs-dir <dir>", "directory for sessions", "runs")
  .option("--json", "emit JSON", false)
  .action(async (o: { runsDir: string; json?: boolean }) => {
    const { listSessions } = await import("./session/store.js");
    const sessions = await listSessions(resolve(o.runsDir, "_sessions"));
    if (o.json) {
      process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
      return;
    }
    if (sessions.length === 0) {
      process.stdout.write("no sessions found\n");
      return;
    }
    for (const s of sessions) {
      process.stdout.write(
        `${s.runId.padEnd(40)} msgs=${String(s.messageCount).padEnd(4)} tok=${String(
          s.tokens
        ).padEnd(8)} $${s.usd.toFixed(3)}  ${s.lastActive}\n`
      );
    }
  });

program
  .command("session")
  .description("inspect or export a persisted session by id")
  .argument("<id>", "session runId or file path")
  .option("--runs-dir <dir>", "directory for sessions", "runs")
  .option("--json", "dump raw JSONL entries", false)
  .action(async (id: string, o: { runsDir: string; json?: boolean }) => {
    const { SessionStore, listSessions } = await import("./session/store.js");
    const dir = resolve(o.runsDir, "_sessions");
    let path = id.endsWith(".jsonl") ? resolve(id) : join(dir, `${id}.jsonl`);
    if (!existsSync(path)) {
      const match = (await listSessions(dir)).find((s) => s.runId === id);
      if (!match) {
        process.stderr.write(`session not found: ${id}\n`);
        process.exit(1);
      }
      path = match.path;
    }
    const store = new SessionStore({
      dir: dirname(path),
      runId: path
        .split("/")
        .pop()
        ?.replace(/\.jsonl$/, "")
    });
    await store.init();
    if (o.json) {
      process.stdout.write(`${JSON.stringify(store.allEntries, null, 2)}\n`);
      return;
    }
    for (const m of store.projection()) {
      process.stdout.write(`[${m.role}${m.name ? `:${m.name}` : ""}] ${m.content.slice(0, 400)}\n`);
    }
  });

program
  .command("compact")
  .description("summarize a persisted session's history")
  .argument("<id>", "session runId or file path")
  .option("--runs-dir <dir>", "directory for sessions", "runs")
  .option("--model <name>", "model", "deepseek-chat")
  .option("--base-url <url>", "endpoint", "http://127.0.0.1:8788/v1/chat/completions")
  .action(async (id: string, o: { runsDir: string; model: string; baseUrl: string }) => {
    const { SessionStore, listSessions } = await import("./session/store.js");
    const { compact, DEFAULT_COMPACTION } = await import("./context/compaction.js");
    const dir = resolve(o.runsDir, "_sessions");
    let path = id.endsWith(".jsonl") ? resolve(id) : join(dir, `${id}.jsonl`);
    if (!existsSync(path)) {
      const match = (await listSessions(dir)).find((s) => s.runId === id);
      if (!match) {
        process.stderr.write(`session not found: ${id}\n`);
        process.exit(1);
      }
      path = match.path;
    }
    const provider = makeProvider({ kind: "openai", baseUrl: o.baseUrl, model: o.model });
    const store = new SessionStore({
      dir: dirname(path),
      runId: path
        .split("/")
        .pop()
        ?.replace(/\.jsonl$/, "")
    });
    await store.init();
    const result = await compact(store.projection(), provider, {
      ...DEFAULT_COMPACTION,
      contextWindow: provider.contextWindow
    });
    process.stdout.write(
      `compacted ${result.compactedCount} messages: ${result.tokensBefore} → ${result.tokensAfter} tokens\n`
    );
    process.stdout.write(`${result.summary}\n`);
  });

program
  .command("checkpoint")
  .description("create a git checkpoint of the current directory")
  .option("--repo <dir>", "git repo directory", "runs/_repo")
  .option("--label <name>", "checkpoint label", "manual")
  .action(async (o: { repo: string; label: string }) => {
    const { gitOrThrow } = await import("./workspace/git.js");
    const repo = resolve(o.repo);
    const tag = `ck-${o.label}-${Date.now()}`;
    await gitOrThrow(["add", "-A"], repo);
    await gitOrThrow(["commit", "-q", "--allow-empty", "-m", `checkpoint ${o.label}`], repo);
    await gitOrThrow(["tag", tag], repo);
    process.stdout.write(`checkpoint ${tag}\n`);
  });

program
  .command("worktree")
  .description("create an isolated git worktree for a task")
  .argument("<name>", "worktree name")
  .option("--repo <dir>", "git repo directory", "runs/_repo")
  .option("--ref <ref>", "git ref (default root)", "root")
  .option("--init-dir <dir>", "initial workspace for an empty repo", "examples/toy-task/init")
  .action(async (name: string, o: { repo: string; ref: string; initDir: string }) => {
    const { GitWorkspace } = await import("./workspace/git.js");
    const repo = resolve(o.repo);
    const ws = new GitWorkspace({
      repoDir: repo,
      worktreesDir: join(repo, "worktrees"),
      initProgramDir: resolve(o.initDir)
    });
    await ws.init();
    const dir = await ws.createWorktree(name, o.ref);
    process.stdout.write(`${dir}\n`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

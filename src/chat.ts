import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { NativeProvider, collectStream } from "./agent/provider.js";
import { modelInfo } from "./agent/models.js";
import { runAgentLoop } from "./agent/loop.js";
import { ToolExecutor, type ToolRegistry } from "./tools/index.js";
import { Hooks, verifyCommandsToHooks } from "./tools/hooks.js";
import { buildPermissionPolicy, type ApprovalHandler } from "./tools/approval.js";
import type { PermissionPolicy } from "./tools/permissions.js";
import { SessionStore } from "./session/store.js";
import { CostTracker } from "./cost.js";
import { DEFAULT_COMPACTION } from "./context/compaction.js";
import { loadMemory } from "./context/memory.js";
import { buildSystemPrompt, environmentBlock } from "./agent/prompts.js";
import { formatHookFeedback } from "./agent/verify.js";
import { buildAgentToolset, skillsPrompt, type AgentToolset } from "./registry.js";
import { printEvent, printStreamEvent } from "./chat-render.js";
import { TurnSnapshots } from "./workspace/snapshot.js";
import { GitWorkspace } from "./workspace/git.js";
import type { BudgetLimits } from "./util/limits.js";

export function sessionsDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.MAZE_SESSIONS_DIR) return resolve(process.env.MAZE_SESSIONS_DIR);
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "maze", "sessions");
}

export interface ChatOnceOptions {
  message: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  maxTurns: number;

  runsDir?: string;
  verifyCommands: string[];
  permission: string;

  budget?: BudgetLimits;

  stream?: boolean;

  instructionGlobs?: string[];

  snapshots?: boolean;

  signal?: AbortSignal;

  approve?: ApprovalHandler;
}

export interface BuiltSession {
  session: SessionStore;
  executor: ToolExecutor;
  hooks: Hooks;
  provider: NativeProvider;
  cost: CostTracker;
  tools: ToolRegistry;

  toolset: AgentToolset;

  restore?: () => Promise<void>;
}

export interface BuildSessionOptions {
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  runsDir?: string;
  verifyCommands: string[];
  permission: string;
  approve?: ApprovalHandler;
}

export async function buildSession(opts: BuildSessionOptions): Promise<BuiltSession> {
  const provider = new NativeProvider({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    contextWindow: opts.contextWindow
  });
  const session = new SessionStore({
    dir: sessionsDir(opts.runsDir),
    model: opts.model,
    cwd: process.cwd()
  });
  await session.init();

  const permission: PermissionPolicy = buildPermissionPolicy(opts.permission, opts.approve);
  const hooks = new Hooks({
    workspaceDir: process.cwd(),
    timeoutMs: 120_000,
    maxOutputBytes: 16 * 1024
  });
  for (const hook of verifyCommandsToHooks(opts.verifyCommands)) hooks.register(hook);

  const toolset = await buildAgentToolset({
    workspaceDir: process.cwd(),
    model: opts.model,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    contextWindow: provider.contextWindow,
    permissionPolicy: permission,
    approve: opts.approve
  });
  for (const warning of toolset.warnings) process.stderr.write(`[harness] ${warning}\n`);
  const tools = toolset.registry;
  const executor = new ToolExecutor({
    registry: tools,
    workspaceDir: process.cwd(),
    permission,
    hooks
  });
  const cost = new CostTracker({ model: opts.model });
  return { session, executor, hooks, provider, cost, tools, toolset };
}

async function maybeSnapshots(enabled: boolean | undefined): Promise<TurnSnapshots | null> {
  if (enabled === false) return null;
  const cwd = process.cwd();
  if (!existsSync(join(cwd, ".git"))) return null;
  const ws = new GitWorkspace({
    repoDir: cwd,
    worktreesDir: join(cwd, ".git", "maze-worktrees"),
    initProgramDir: cwd
  });
  return new TurnSnapshots({ commitWorkspace: (dir, msg) => ws.commitWorkspace(dir, msg) }, cwd);
}

export async function runChatOnce(opts: ChatOnceOptions): Promise<void> {
  const memory = await loadMemory(process.cwd(), opts.instructionGlobs);
  const built = await buildSession(opts);
  const skillSection = skillsPrompt(built.toolset.skills);
  const info = modelInfo(opts.model, { contextWindow: opts.contextWindow });
  const snapshots = await maybeSnapshots(opts.snapshots);
  try {
    const result = await runAgentLoop(
      {
        provider: built.provider,
        tools: built.tools.list(),
        executor: built.executor,
        session: built.session,
        systemPrompt: await buildSystemPrompt({
          memory: memory.text,
          extra: skillSection || undefined,
          environment: environmentBlock({
            cwd: process.cwd(),
            mode: "chat",
            gitRepo: snapshots !== null,
            model: opts.model
          })
        }),
        maxTurns: opts.maxTurns,
        compaction: { ...DEFAULT_COMPACTION, contextWindow: info.contextWindow },
        cost: built.cost,
        budget: opts.budget,
        signal: opts.signal,
        beginTurn: snapshots ? () => snapshots.snapshot("chat-turn") : undefined,
        stream:
          opts.stream !== false
            ? (messages, tools, signal) =>
                collectStream(built.provider, messages, tools, {
                  signal,
                  onEvent: (e) => printStreamEvent(e)
                })
            : undefined,
        onEvent: (event) => {
          printEvent(event);
          if (event.type === "hooks") {
            const text = formatHookFeedback(event.results);
            if (text.trim()) process.stderr.write(`${text}\n`);
          }
        }
      },
      opts.message
    );
    const usage = built.cost.summary();
    process.stdout.write(
      `\n[session ${built.session.path}] stop=${result.stopReason} turns=${result.turns} tokens=${usage.totalTokens} $${usage.usd.toFixed(4)}\n`
    );

    if (result.stopReason === "error" || result.stopReason === "loop") process.exitCode = 1;
    if (result.stopReason === "budget") process.exitCode = 3;
  } finally {
    built.toolset.close();
  }
}

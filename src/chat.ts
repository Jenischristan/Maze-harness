import { resolve } from "node:path";
import { OpenAICompatProvider } from "./agent/provider.js";
import type { ChatResult } from "./types.js";
import { runAgentLoop, type AgentEvent } from "./agent/loop.js";
import { ToolExecutor, ToolRegistry } from "./tools/index.js";
import { Hooks, verifyCommandsToHooks } from "./tools/hooks.js";
import { DEFAULT_PERMISSION_POLICY, type PermissionPolicy } from "./tools/permissions.js";
import { SessionStore } from "./session/store.js";
import { CostTracker } from "./cost.js";
import { DEFAULT_COMPACTION } from "./context/compaction.js";
import { loadMemory } from "./context/memory.js";
import { buildSystemPrompt } from "./agent/prompts.js";
import { formatHookFeedback } from "./agent/verify.js";
import { buildAgentToolset, skillsPrompt, type AgentToolset } from "./registry.js";
import { printEvent } from "./chat-render.js";

export interface ChatOnceOptions {
  message: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  maxTurns: number;
  runsDir: string;
  verifyCommands: string[];
  permission: string;
}

function permissionPolicy(mode: string): PermissionPolicy {
  const action = mode === "ask" ? "ask" : mode === "deny" ? "deny" : "allow";
  return { ...DEFAULT_PERMISSION_POLICY, defaultAction: action };
}

export interface BuiltSession {
  session: SessionStore;
  executor: ToolExecutor;
  hooks: Hooks;
  provider: OpenAICompatProvider;
  cost: CostTracker;
  tools: ToolRegistry;
  /** MCP clients + skills attached to this session; close() on exit. */
  toolset: AgentToolset;
}

export async function buildSession(opts: {
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow: number;
  runsDir: string;
  verifyCommands: string[];
  permission: string;
}): Promise<BuiltSession> {
  const provider = new OpenAICompatProvider({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    contextWindow: opts.contextWindow
  });
  const runsDir = resolve(opts.runsDir);
  const session = new SessionStore({ dir: resolve(runsDir, "_sessions"), model: opts.model });
  await session.init();
  const hooks = new Hooks({
    workspaceDir: process.cwd(),
    timeoutMs: 120_000,
    maxOutputBytes: 16 * 1024
  });
  for (const hook of verifyCommandsToHooks(opts.verifyCommands)) hooks.register(hook);
  // Use the shared toolset builder so MCP servers, skills, and the `delegate`
  // sub-agent tool are available to the non-interactive chat path. This used
  // to be a bare ToolRegistry.
  const toolset = await buildAgentToolset({
    workspaceDir: process.cwd(),
    model: opts.model,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    contextWindow: opts.contextWindow
  });
  for (const warning of toolset.warnings) process.stderr.write(`[harness] ${warning}\n`);
  const tools = toolset.registry;
  const executor = new ToolExecutor({
    registry: tools,
    workspaceDir: process.cwd(),
    permission: permissionPolicy(opts.permission),
    hooks
  });
  const cost = new CostTracker({ model: opts.model });
  return { session, executor, hooks, provider, cost, tools, toolset };
}

export async function runChatOnce(opts: ChatOnceOptions): Promise<void> {
  const memory = await loadMemory(process.cwd());
  const built = await buildSession(opts);
  const skillSection = skillsPrompt(built.toolset.skills);
  const result = await runAgentLoop(
    {
      provider: built.provider,
      tools: built.tools.list(),
      executor: built.executor,
      session: built.session,
      systemPrompt: await buildSystemPrompt({
        memory: memory.text,
        extra: skillSection || undefined
      }),
      maxTurns: opts.maxTurns,
      compaction: { ...DEFAULT_COMPACTION, contextWindow: opts.contextWindow },
      cost: built.cost,
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
  built.toolset.close();
  const usage = built.cost.summary();
  process.stdout.write(
    `\n[session ${built.session.path}] stop=${result.stopReason} turns=${result.turns} tokens=${usage.totalTokens} $${usage.usd.toFixed(4)}\n`
  );
  if (result.stopReason === "error" || result.stopReason === "loop") process.exitCode = 1;
}


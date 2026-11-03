import { join, resolve } from "node:path";
import type {
  ChatProvider,
  DiscoveryAgent,
  DiscoveryNode,
  AgentContext,
  TaskSpec
} from "../types.js";
import { DEFAULT_PERMISSION_POLICY, type PermissionPolicy } from "../tools/permissions.js";
import { ToolExecutor, type ToolRegistry } from "../tools/index.js";
import { buildAgentToolset, skillsPrompt, type AgentToolset } from "../registry.js";
import { makeDefaultHooks, writeTranscript } from "../agent/verify.js";
import { runAgentLoop, type AgentEvent } from "../agent/loop.js";
import { SessionStore } from "../session/store.js";
import { CostTracker } from "../cost.js";
import { DEFAULT_COMPACTION } from "../context/compaction.js";
import { loadMemory } from "../context/memory.js";
import { buildSystemPrompt } from "../agent/prompts.js";
import type { BudgetLimits } from "../util/limits.js";

export interface ToolAgentConfig {
  provider: ChatProvider;

  permission?: PermissionPolicy;

  verifyCommands?: string[];

  runsDir: string;

  maxTurns?: number;

  instructions?: string;

  explorationModel?: string;

  onEvent?: (event: AgentEvent) => void;

  contextWindow?: number;

  maxOutputBytes?: number;

  signal?: AbortSignal;

  enableMcp?: boolean;

  budget?: BudgetLimits;
}

async function renderSystemPrompt(
  task: TaskSpec,
  memory: string,
  instructions?: string
): Promise<string> {
  const base = await buildSystemPrompt({ memory, extra: instructions });
  return [
    base,
    "",
    `# Task: ${task.name}`,
    task.description,
    "",
    "Work inside the workspace. When the task is complete, reply with a short summary and no tool calls."
  ].join("\n");
}

function renderUserPrompt(context: AgentContext): string {
  const lines: string[] = [];
  lines.push(context.taskPrompt);
  lines.push("");
  lines.push(
    `Attempt: branch ${context.branch}, attempt ${context.attempt} (node ${context.nodeId}).`
  );
  if (context.ancestorPath.length > 0) {
    lines.push("");
    lines.push("History along this branch (oldest first):");
    for (const obs of context.ancestorPath) {
      lines.push(
        `- ${obs.id}: score=${obs.score ?? "null"} fail=${obs.failClass}${
          obs.error ? ` error=${obs.error}` : ""
        } deltaVsParent=${obs.deltaVsParent ?? "null"}`
      );
    }
    const failures = context.ancestorPath.filter((o) => !o.valid);
    if (failures.length > 0) {
      lines.push("");
      lines.push(
        "A previous attempt failed. Repair the most recent failure; do not repeat a failed design."
      );
    }
  }
  return lines.join("\n");
}

export class ToolAgent implements DiscoveryAgent {
  private readonly cfg: ToolAgentConfig;

  private registry: ToolRegistry | null = null;

  constructor(cfg: ToolAgentConfig) {
    this.cfg = cfg;
  }

  async run(input: {
    workspaceDir: string;
    task: TaskSpec;
    parent: DiscoveryNode | null;
    context: AgentContext;
  }): Promise<{ transcriptPath?: string; tokens?: number }> {
    const workspaceDir = resolve(input.workspaceDir);
    const session = new SessionStore({
      dir: join(this.cfg.runsDir, "_sessions"),
      runId: `${this.cfg.provider.model}-${input.context.nodeId}-${Date.now().toString(36)}`,
      model: this.cfg.provider.model,
      cwd: workspaceDir
    });
    await session.init();
    const permission = this.cfg.permission ?? DEFAULT_PERMISSION_POLICY;
    const verify = this.cfg.verifyCommands ?? [];
    const hooks = makeDefaultHooks(verify, {
      workspaceDir,
      maxOutputBytes: this.cfg.maxOutputBytes
    });
    const cost = new CostTracker({
      model: this.cfg.provider.model,
      explorationModel: this.cfg.explorationModel
    });

    const toolset: AgentToolset = await buildAgentToolset({
      workspaceDir,
      model: this.cfg.provider.model,
      baseUrl: process.env.DREAM_BASE_URL ?? "",
      apiKey: process.env.DREAM_API_KEY ?? process.env.DEEPSEEK_ROUTER_KEY ?? "",
      contextWindow: this.cfg.contextWindow ?? this.cfg.provider.contextWindow,
      enableMcp: this.cfg.enableMcp
    });
    this.registry = toolset.registry;
    const executor = new ToolExecutor({
      registry: toolset.registry,
      workspaceDir,
      permission,
      hooks,
      maxOutputBytes: this.cfg.maxOutputBytes
    });
    try {
      const memory = await loadMemory(workspaceDir);
      const extra = [this.cfg.instructions, skillsPrompt(toolset.skills)]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join("\n\n");
      const systemPrompt = await renderSystemPrompt(input.task, memory.text, extra || undefined);
      const contextWindow = this.cfg.contextWindow ?? this.cfg.provider.contextWindow;

      const result = await runAgentLoop(
        {
          provider: this.cfg.provider,
          tools: toolset.registry.list(),
          executor,
          session,
          systemPrompt,
          maxTurns: this.cfg.maxTurns ?? 40,
          compaction: { ...DEFAULT_COMPACTION, contextWindow },
          cost,
          budget: this.cfg.budget,
          onEvent: this.cfg.onEvent,
          signal: this.cfg.signal
        },
        renderUserPrompt(input.context)
      );

      const usage = cost.summary();
      const transcriptDir = join(this.cfg.runsDir, "_transcripts");
      const transcriptPath = await writeTranscript(
        transcriptDir,
        `${input.context.nodeId}.log`,
        [
          `# model ${this.cfg.provider.model}`,
          `# stopReason ${result.stopReason} turns=${result.turns}`,
          `# usage ${JSON.stringify(usage)}`,
          `# session ${session.path}`,
          "",
          "# system",
          systemPrompt,
          "",
          "# messages",
          JSON.stringify(session.allEntries, null, 2)
        ].join("\n")
      );
      if (result.stopReason === "loop") {
        throw new Error(result.error ?? "agent loop detected");
      }
      if (result.stopReason === "error") {
        throw new Error(result.error ?? "agent failed");
      }
      return { transcriptPath, tokens: usage.totalTokens };
    } finally {
      toolset.close();
    }
  }
}

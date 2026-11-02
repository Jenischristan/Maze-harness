import { join, resolve } from "node:path";
import type {
  ChatProvider,
  DiscoveryAgent,
  DiscoveryNode,
  AgentContext,
  TaskSpec
} from "../types.js";
import type { PermissionPolicy } from "../tools/permissions.js";
import { DEFAULT_PERMISSION_POLICY } from "../tools/permissions.js";
import { ToolRegistry } from "../tools/index.js";
import { ToolExecutor } from "../tools/index.js";
import { makeDefaultHooks } from "../agent/verify.js";
import { runAgentLoop, type AgentEvent } from "../agent/loop.js";
import { SessionStore } from "../session/store.js";
import { CostTracker } from "../cost.js";
import { DEFAULT_COMPACTION } from "../context/compaction.js";
import { loadMemory } from "../context/memory.js";
import { writeTranscript } from "../agent/verify.js";
import { buildSystemPrompt } from "../agent/prompts.js";

export interface ToolAgentConfig {
  provider: ChatProvider;
  /** Permission policy; defaults to the safe built-in policy. */
  permission?: PermissionPolicy;
  /** Verification commands (tests/typecheck/lint) run after edits. */
  verifyCommands?: string[];
  /** Where JSONL sessions are stored. Defaults to `<runsDir>/_sessions`. */
  runsDir: string;
  /** Max agent turns per attempt. */
  maxTurns?: number;
  /** Extra instructions appended to the system prompt. */
  instructions?: string;
  /** Optional named model routing for exploration. */
  explorationModel?: string;
  /** Subscribe to events for UI streaming. */
  onEvent?: (event: AgentEvent) => void;
  /** Context window override. */
  contextWindow?: number;
  /** Per-tool output byte budget. */
  maxOutputBytes?: number;
  /** Abort signal. */
  signal?: AbortSignal;
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
  lines.push(`Attempt: branch ${context.branch}, attempt ${context.attempt} (node ${context.nodeId}).`);
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

/**
 * Native tool-calling discovery agent. Uses the OpenAI-compatible provider,
 * built-in tools, permission policy, verification hooks, compaction, session
 * persistence, and cost tracking.
 */
export class ToolAgent implements DiscoveryAgent {
  private readonly cfg: ToolAgentConfig;
  private readonly registry = new ToolRegistry();

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
    const hooks = makeDefaultHooks(verify, { workspaceDir, maxOutputBytes: this.cfg.maxOutputBytes });
    const executor = new ToolExecutor({
      registry: this.registry,
      workspaceDir,
      permission,
      hooks,
      maxOutputBytes: this.cfg.maxOutputBytes
    });
    const cost = new CostTracker({
      model: this.cfg.provider.model,
      explorationModel: this.cfg.explorationModel
    });
    const memory = await loadMemory(workspaceDir);
    const systemPrompt = await renderSystemPrompt(input.task, memory.text, this.cfg.instructions);
    const contextWindow = this.cfg.contextWindow ?? this.cfg.provider.contextWindow;

    const result = await runAgentLoop(
      {
        provider: this.cfg.provider,
        tools: this.registry.list(),
        executor,
        session,
        systemPrompt,
        maxTurns: this.cfg.maxTurns ?? 40,
        compaction: { ...DEFAULT_COMPACTION, contextWindow },
        cost,
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
  }
}

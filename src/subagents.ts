import { OpenAICompatProvider } from "./agent/provider.js";
import { ToolExecutor, ToolRegistry } from "./tools/index.js";
import { Hooks, verifyCommandsToHooks } from "./tools/hooks.js";
import { DEFAULT_PERMISSION_POLICY, type PermissionPolicy } from "./tools/permissions.js";
import { DEFAULT_COMPACTION } from "./context/compaction.js";
import { buildSystemPrompt } from "./agent/prompts.js";
import { loadMemory } from "./context/memory.js";
import { runAgentLoop, type AgentEvent } from "./agent/loop.js";
import { CostTracker } from "./cost.js";
import { SessionStore } from "./session/store.js";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * Sub-agent presets. Each preset is a specialist the main agent (or the user
 * via `/agents`) can delegate a self-contained task to. The sub-agent runs a
 * full tool loop in the same workspace but with its own session and prompt, so
 * it can read many files and burn context without polluting the main thread.
 */
export interface SubAgentSpec {
  name: string;
  description: string;
  /** Extra system-prompt section that defines the specialist's role. */
  prompt: string;
  /** Tools the specialist may use (defaults to all builtins). */
  tools?: string[];
  maxTurns?: number;
}

export const SUBAGENTS: SubAgentSpec[] = [
  {
    name: "explore",
    description: "Search and read the codebase; report findings, no edits",
    prompt: [
      "# Role: explorer",
      "",
      "You explore a codebase and report what you find. You do not modify files.",
      "Locate the relevant files and symbols, read them, and return a concise map:",
      "file paths with line numbers, how the pieces connect, and any gotchas.",
      "Prefer grep/glob over guessing. Stop as soon as the question is answered."
    ].join("\n"),
    tools: ["read", "grep", "glob", "bash"],
    maxTurns: 20
  },
  {
    name: "review",
    description: "Review a diff for bugs, regressions, and missing tests",
    prompt: [
      "# Role: code reviewer",
      "",
      "You review changes for correctness. Read the diff and the surrounding code,",
      "then report only real defects: logic errors, broken invariants, missing edge",
      "cases, and untested behavior. Cite path:line. Do not rewrite the code.",
      "Rank findings by severity and be explicit when something is fine."
    ].join("\n"),
    tools: ["read", "grep", "glob", "bash"],
    maxTurns: 24
  },
  {
    name: "test",
    description: "Write or fix tests for a described behavior",
    prompt: [
      "# Role: test engineer",
      "",
      "You write focused, deterministic tests. Read the implementation first, then",
      "add the smallest tests that pin the behavior. Follow the project's existing",
      "test framework and style. Run the tests and fix them until they pass."
    ].join("\n"),
    maxTurns: 30
  },
  {
    name: "plan",
    description: "Produce an implementation plan without touching files",
    prompt: [
      "# Role: planner",
      "",
      "You turn a request into a concrete implementation plan. Investigate the repo",
      "read-only, then return ordered steps naming files and functions, the risks,",
      "and how each step will be verified. Do not edit anything."
    ].join("\n"),
    tools: ["read", "grep", "glob"],
    maxTurns: 16
  },
  {
    name: "verify",
    description: "Run build/tests/lint and report failures with causes",
    prompt: [
      "# Role: verifier",
      "",
      "You run the project's verification commands (typecheck, tests, lint), read",
      "the failures, and report the root cause of each. Do not fix code unless the",
      "fix is a trivial, obviously-correct one; otherwise report precisely."
    ].join("\n"),
    maxTurns: 24
  }
];

export function findSubAgent(name: string): SubAgentSpec | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  return SUBAGENTS.find((a) => a.name === q) ?? SUBAGENTS.find((a) => a.name.startsWith(q)) ?? null;
}

export interface SubAgentRunOptions {
  spec: SubAgentSpec;
  task: string;
  workspaceDir: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  /** Default action when no rule matches. Defaults to "deny". */
  permission?: "allow" | "ask" | "deny";
  /** Full parent policy to inherit (rules, allowlists, and `ask` handler). */
  permissionPolicy?: PermissionPolicy;
  /** Approval handler for inherited `ask` rules, when the caller has one. */
  approve?: (input: {
    tool: string;
    pattern: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;
  verifyCommands?: string[];
  /** Registry carrying builtin + MCP tools; filtered by the spec's allowlist. */
  registry?: ToolRegistry;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface SubAgentResult {
  text: string;
  turns: number;
  stopReason: string;
  tokens: { promptTokens: number; completionTokens: number; totalTokens: number; usd: number };
  transcriptPath: string;
}

/**
 * Run a specialist sub-agent to completion and return its final answer.
 *
 * The sub-agent gets its own SessionStore (persisted under
 * `runs/_sessions/subagents/`) so its exploration is auditable but never mixed
 * into the parent conversation.
 */
export async function runSubAgent(opts: SubAgentRunOptions): Promise<SubAgentResult> {
  const { spec } = opts;
  const provider = new OpenAICompatProvider({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    contextWindow: opts.contextWindow ?? 128_000
  });
  const session = new SessionStore({
    dir: resolve(opts.workspaceDir, "runs", "_sessions", "subagents"),
    model: opts.model,
    name: `subagent:${spec.name}`,
    cwd: opts.workspaceDir
  });
  await session.init();

  // Sub-agents used to default to `allow` and never wired an `ask` handler, so
  // delegated work silently bypassed the user's permission choice. Inherit the
  // parent policy when one is supplied and fail closed otherwise: an `ask`
  // without a handler denies, and a missing policy denies mutating tools.
  const base = opts.permissionPolicy ?? DEFAULT_PERMISSION_POLICY;
  const permission: PermissionPolicy = {
    ...base,
    defaultAction: opts.permission ?? base.defaultAction,
    ask: opts.approve ?? base.ask
  };
  const hooks = new Hooks({
    workspaceDir: opts.workspaceDir,
    timeoutMs: 120_000,
    maxOutputBytes: 16 * 1024
  });
  for (const hook of verifyCommandsToHooks(opts.verifyCommands ?? [])) hooks.register(hook);

  const baseRegistry = opts.registry ?? new ToolRegistry();
  const allowed = spec.tools ? new Set(spec.tools) : null;
  const tools: ToolDefinition[] = baseRegistry
    .list()
    .filter((t) => (allowed ? allowed.has(t.name) : true));
  const executor = new ToolExecutor({
    registry: baseRegistry,
    workspaceDir: opts.workspaceDir,
    permission,
    hooks
  });

  const memory = await loadMemory(opts.workspaceDir);
  const systemPrompt = await buildSystemPrompt({ memory: memory.text, extra: spec.prompt });
  const cost = new CostTracker({ model: opts.model });

  const result = await runAgentLoop(
    {
      provider,
      tools,
      executor,
      session,
      systemPrompt,
      maxTurns: spec.maxTurns ?? 24,
      compaction: { ...DEFAULT_COMPACTION, contextWindow: opts.contextWindow ?? 128_000 },
      cost,
      signal: opts.signal,
      onEvent: opts.onEvent
    },
    opts.task
  );

  // The final assistant text is the last assistant message in the projection.
  let text = "";
  for (const m of session.projection()) {
    if (m.role === "assistant" && m.content.trim()) text = m.content.trim();
  }
  return {
    text: text || "(sub-agent produced no final answer)",
    turns: result.turns,
    stopReason: result.stopReason,
    tokens: cost.summary(),
    transcriptPath: session.path
  };
}

/**
 * Wrap sub-agent delegation as a tool so the *main* agent can spawn
 * specialists on its own. This is the harness's "agents as tools" mechanism.
 */
export function subAgentTool(opts: {
  workspaceDir: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  registry?: ToolRegistry;
  /** Parent permission policy inherited by every delegated sub-agent. */
  permissionPolicy?: PermissionPolicy;
  /** Parent approval handler for `ask` decisions. */
  approve?: (input: {
    tool: string;
    pattern: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;
}): ToolDefinition {
  return {
    name: "delegate",
    description:
      "Delegate a self-contained sub-task to a specialist sub-agent and get its final report. " +
      `Available agents: ${SUBAGENTS.map((a) => `${a.name} (${a.description})`).join("; ")}. ` +
      "The sub-agent has its own context, can use tools, and cannot ask follow-up questions — give it a complete task.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: `One of: ${SUBAGENTS.map((a) => a.name).join(", ")}.`
        },
        task: { type: "string", description: "A complete, self-contained task description." }
      },
      required: ["agent", "task"],
      additionalProperties: false
    },
    async execute(args): Promise<ToolResult> {
      const spec = findSubAgent(String(args.agent ?? ""));
      if (!spec) {
        return {
          callId: "",
          name: "delegate",
          ok: false,
          content: `unknown sub-agent: ${String(args.agent)} (available: ${SUBAGENTS.map((a) => a.name).join(", ")})`,
          error: "unknown-subagent"
        };
      }
      const task = String(args.task ?? "").trim();
      if (!task) {
        return {
          callId: "",
          name: "delegate",
          ok: false,
          content: "delegate requires a task",
          error: "no-task"
        };
      }
      try {
        const result = await runSubAgent({
          spec,
          task,
          workspaceDir: opts.workspaceDir,
          model: opts.model,
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          contextWindow: opts.contextWindow,
          registry: opts.registry,
          permissionPolicy: opts.permissionPolicy,
          approve: opts.approve
        });
        return {
          callId: "",
          name: "delegate",
          ok: result.stopReason === "done",
          content: `[${spec.name}] ${result.text}\n\n(turns=${result.turns} stop=${result.stopReason} tokens=${result.tokens.totalTokens})`,
          data: { transcript: result.transcriptPath, tokens: result.tokens }
        };
      } catch (err) {
        return {
          callId: "",
          name: "delegate",
          ok: false,
          content: `sub-agent failed: ${err instanceof Error ? err.message : String(err)}`,
          error: "subagent-error"
        };
      }
    }
  };
}

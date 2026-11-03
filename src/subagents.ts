import { NativeProvider, collectStream } from "./agent/provider.js";
import { ToolExecutor, ToolRegistry } from "./tools/index.js";
import { Hooks, verifyCommandsToHooks } from "./tools/hooks.js";
import { DEFAULT_PERMISSION_POLICY, type PermissionPolicy } from "./tools/permissions.js";
import { DEFAULT_COMPACTION } from "./context/compaction.js";
import { buildSystemPrompt, environmentBlock } from "./agent/prompts.js";
import { loadMemory } from "./context/memory.js";
import { runAgentLoop, type AgentEvent } from "./agent/loop.js";
import { CostTracker } from "./cost.js";
import { SessionStore } from "./session/store.js";
import { sessionsDir } from "./chat.js";
import { discoverAgents, toolsForAgent, type AgentDefinition } from "./agents/definitions.js";
import { resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

export interface SubAgentSpec {
  name: string;
  description: string;

  prompt: string;

  tools?: string[];
  maxTurns?: number;

  model?: string;

  readOnly?: boolean;
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
    tools: ["read", "grep", "glob", "ls"],
    maxTurns: 20,
    readOnly: true
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
    tools: ["read", "grep", "glob", "ls"],
    maxTurns: 24,
    readOnly: true
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
    tools: ["read", "grep", "glob", "ls"],
    maxTurns: 16,
    readOnly: true
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

export function specFromDefinition(def: AgentDefinition): SubAgentSpec {
  return {
    name: def.name,
    description: def.description,
    prompt: def.prompt,
    tools: def.tools,
    maxTurns: def.maxTurns,
    model: def.model,
    readOnly: def.readOnly
  };
}

export function findSubAgent(name: string, specs: SubAgentSpec[] = SUBAGENTS): SubAgentSpec | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  return specs.find((a) => a.name === q) ?? specs.find((a) => a.name.startsWith(q)) ?? null;
}

export interface SubAgentRunOptions {
  spec: SubAgentSpec;
  task: string;
  workspaceDir: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;

  /** Provider retry attempt count. Keep low in tests to avoid slow backoff. */
  retries?: number;

  /** Base delay between provider retries, in milliseconds. */
  retryBaseMs?: number;

  /** Per-request timeout for the provider, in milliseconds. */
  requestTimeoutMs?: number;

  permission?: "allow" | "ask" | "deny";

  permissionPolicy?: PermissionPolicy;

  approve?: (input: {
    tool: string;
    pattern: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;
  verifyCommands?: string[];

  registry?: ToolRegistry;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;

  sessionsDir?: string;

  cost?: CostTracker;
}

export interface SubAgentResult {
  text: string;
  turns: number;
  stopReason: string;
  tokens: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    reasoningTokens: number;
    usd: number;
    calls: number;
  };
  transcriptPath: string;
}

export async function runSubAgent(opts: SubAgentRunOptions): Promise<SubAgentResult> {
  const { spec } = opts;
  const model = spec.model ?? opts.model;
  const provider = new NativeProvider({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model,
    contextWindow: opts.contextWindow,
    retries: opts.retries,
    retryBaseMs: opts.retryBaseMs,
    requestTimeoutMs: opts.requestTimeoutMs
  });
  const session = new SessionStore({
    dir: resolve(opts.sessionsDir ?? sessionsDir(), "subagents"),
    model,
    name: `subagent:${spec.name}`,
    cwd: opts.workspaceDir
  });
  await session.init();

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
  const tools: ToolDefinition[] = toolsForAgent(
    {
      name: spec.name,
      description: spec.description,
      mode: "subagent",
      prompt: spec.prompt,
      tools: spec.tools,
      maxTurns: spec.maxTurns,
      readOnly: spec.readOnly,
      source: "subagent"
    },
    baseRegistry.list()
  );
  const executor = new ToolExecutor({
    registry: baseRegistry,
    workspaceDir: opts.workspaceDir,
    permission,
    hooks,
    mediaTypes: provider.info.capabilities.images
      ? ["image/png", "image/jpeg", "image/gif", "image/webp"]
      : undefined
  });

  const memory = await loadMemory(opts.workspaceDir);
  const systemPrompt = await buildSystemPrompt({
    memory: memory.text,
    extra: spec.prompt,
    model,
    environment: environmentBlock({
      cwd: opts.workspaceDir,
      mode: "subagent",
      gitRepo: false,
      model
    })
  });
  const cost = opts.cost ?? new CostTracker({ model });

  const result = await runAgentLoop(
    {
      provider,
      tools,
      executor,
      session,
      systemPrompt,
      maxTurns: spec.maxTurns ?? 24,
      compaction: { ...DEFAULT_COMPACTION, contextWindow: provider.contextWindow },
      cost,
      signal: opts.signal,
      onEvent: opts.onEvent,
      stream: (messages, toolDefs, signal) =>
        collectStream(provider, messages, toolDefs, { signal })
    },
    opts.task
  );

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

export function subAgentTool(opts: {
  workspaceDir: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  registry?: ToolRegistry;

  /** Provider retry attempt count. Keep low in tests to avoid slow backoff. */
  retries?: number;

  /** Base delay between provider retries, in milliseconds. */
  retryBaseMs?: number;

  /** Per-request timeout for the provider, in milliseconds. */
  requestTimeoutMs?: number;

  permissionPolicy?: PermissionPolicy;

  approve?: (input: {
    tool: string;
    pattern: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;

  agents?: AgentDefinition[];
  sessionsDir?: string;
  cost?: CostTracker;
}): ToolDefinition {
  const specs = [
    ...SUBAGENTS,
    ...(opts.agents ?? []).filter((a) => a.mode === "subagent").map(specFromDefinition)
  ];
  const byName = new Map<string, SubAgentSpec>();
  for (const s of specs) byName.set(s.name, s);
  const available = [...byName.values()];
  return {
    name: "delegate",
    description:
      "Delegate a self-contained sub-task to a specialist sub-agent and get its final report. " +
      `Available agents: ${available.map((a) => `${a.name} (${a.description})`).join("; ")}. ` +
      "The sub-agent has its own context, can use tools, and cannot ask follow-up questions — give it a complete task.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: `One of: ${available.map((a) => a.name).join(", ")}.`
        },
        task: { type: "string", description: "A complete, self-contained task description." }
      },
      required: ["agent", "task"],
      additionalProperties: false
    },
    async execute(args): Promise<ToolResult> {
      const spec = findSubAgent(String(args.agent ?? ""), available);
      if (!spec) {
        return {
          callId: "",
          name: "delegate",
          ok: false,
          content: `unknown sub-agent: ${String(args.agent)} (available: ${available.map((a) => a.name).join(", ")})`,
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
          retries: opts.retries,
          retryBaseMs: opts.retryBaseMs,
          requestTimeoutMs: opts.requestTimeoutMs,
          registry: opts.registry,
          permissionPolicy: opts.permissionPolicy,
          approve: opts.approve,
          sessionsDir: opts.sessionsDir,
          cost: opts.cost
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

export { discoverAgents, type AgentDefinition };

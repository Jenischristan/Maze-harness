import type { HookResult, HookRegistry } from "./hookTypes.js";
import type { PermissionPolicy } from "./permissions.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";
import { readTool } from "./read.js";
import { grepTool, globTool, lsTool } from "./search.js";
import { editTool } from "./edit.js";
import { writeTool } from "./write.js";
import { applyPatchTool } from "./patch.js";
import { bashTool } from "./bash.js";
import { pageTool } from "./page.js";
import { todoTool } from "./todo.js";
import { questionTool } from "./question.js";
import { lspTool } from "./lsp.js";
import { fetchTool } from "./fetch.js";
import { webfetchTool, websearchTool } from "./web.js";
import { multieditTool } from "./multiedit.js";
import { isReadOnlyTool } from "./kinds.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./limits.js";

export * from "./permissions.js";
export * from "./truncate.js";
export * from "./limits.js";
export * from "./hookTypes.js";
export { resetShells } from "./bash.js";
export { setQuestionHandler, ttyQuestionHandler } from "./question.js";
export { readTodos, renderTodos } from "./todo.js";
export { isReadOnlyTool } from "./kinds.js";
export {
  readTool,
  writeTool,
  editTool,
  applyPatchTool,
  bashTool,
  globTool,
  grepTool,
  lsTool,
  multieditTool,
  todoTool,
  questionTool,
  lspTool,
  webfetchTool,
  websearchTool
};

const BUILTIN_TOOLS: ToolDefinition[] = [
  readTool,
  grepTool,
  globTool,
  lsTool,
  editTool,
  multieditTool,
  applyPatchTool,
  writeTool,
  bashTool,
  pageTool,
  todoTool,
  questionTool,
  lspTool
];

export const NETWORK_TOOLS: ToolDefinition[] = [fetchTool, webfetchTool, websearchTool];

export const ALL_TOOLS: ToolDefinition[] = [...BUILTIN_TOOLS, ...NETWORK_TOOLS];

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = ALL_TOOLS) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  schema(): Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }> {
    return this.list().map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
  }
}

export interface ExecutorOptions {
  registry: ToolRegistry;
  workspaceDir: string;
  permission: PermissionPolicy;
  hooks: HookRegistry;
  maxOutputBytes?: number;

  loopThreshold?: number;

  mediaTypes?: string[];
}

export interface ExecutedBatch {
  results: ToolResult[];
  hookResults: HookResult[];
  loopDetected: boolean;
}

export class ToolExecutor {
  readonly readFiles = new Set<string>();
  readonly readHashes = new Map<string, string>();
  readonly modifiedFiles = new Set<string>();
  private readonly opts: ExecutorOptions;
  private readonly seen = new Map<string, number>();

  private signal: AbortSignal | undefined;

  constructor(opts: ExecutorOptions) {
    this.opts = opts;
  }

  setSignal(signal: AbortSignal | undefined): void {
    this.signal = signal;
  }

  context(): ToolContext {
    return {
      workspaceDir: this.opts.workspaceDir,
      readFiles: this.readFiles,
      readHashes: this.readHashes,
      modifiedFiles: this.modifiedFiles,
      maxOutputBytes: this.opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      permission: this.opts.permission,
      hooks: this.opts.hooks,
      signal: this.signal,
      mediaTypes: this.opts.mediaTypes
    };
  }

  async runBatch(
    calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  ): Promise<ExecutedBatch> {
    const ctx = this.context();
    if (this.signal?.aborted) {
      return {
        results: calls.map((call) => ({
          callId: call.id,
          name: call.name,
          ok: false,
          content: "aborted before execution",
          error: "aborted"
        })),
        hookResults: [],
        loopDetected: false
      };
    }
    const results: ToolResult[] = new Array(calls.length);
    const parallelIdx: number[] = [];
    const serialIdx: number[] = [];
    let loopDetected = false;
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i]!;
      const key = `${call.name}:${stableStringify(call.arguments)}`;
      const count = (this.seen.get(key) ?? 0) + 1;
      this.seen.set(key, count);
      if (count > (this.opts.loopThreshold ?? 4) && !isReadOnlyTool(call.name)) {
        results[i] = {
          callId: call.id,
          name: call.name,
          ok: false,
          content: `loop detected: identical ${call.name} call repeated ${count} times`,
          error: "loop"
        };
        loopDetected = true;
        continue;
      }
      if (isReadOnlyTool(call.name)) parallelIdx.push(i);
      else serialIdx.push(i);
    }
    const parallel = await Promise.all(
      parallelIdx.map(async (i) => {
        const call = calls[i]!;
        const def = this.opts.registry.get(call.name);
        if (!def) return { i, result: unknownTool(call) };
        return { i, result: await this.safeExecute(def, call, ctx) };
      })
    );
    for (const { i, result } of parallel) results[i] = result;

    let mutated = false;
    for (const i of serialIdx) {
      if (results[i]) continue;
      const call = calls[i]!;
      const def = this.opts.registry.get(call.name);
      if (!def) {
        results[i] = unknownTool(call);
        continue;
      }
      results[i] = await this.safeExecute(def, call, ctx);
      if (results[i]!.ok) mutated = true;
    }

    let hookResults: HookResult[] = [];
    if (mutated && this.opts.hooks.list().length > 0 && !this.signal?.aborted) {
      hookResults = await this.opts.hooks.runAll(this.signal);
    }
    return { results: results.filter(Boolean), hookResults, loopDetected };
  }

  private async safeExecute(
    def: ToolDefinition,
    call: { id: string; name: string; arguments: Record<string, unknown> },
    ctx: ToolContext
  ): Promise<ToolResult> {
    const invalid = validateArgs(def.parameters, call.arguments);
    if (invalid) {
      return {
        callId: call.id,
        name: call.name,
        ok: false,
        content: `invalid arguments for ${call.name}: ${invalid}`,
        error: "invalid-arguments"
      };
    }
    try {
      const result = await def.execute(call.arguments, ctx);
      return { ...result, callId: call.id, name: call.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId: call.id,
        name: call.name,
        ok: false,
        content: `tool error: ${message}`,
        error: message
      };
    }
  }
}

export function validateArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>
): string | null {
  if ("__parseError" in args) {
    const raw = args.__parseError;
    return `arguments were not valid JSON: ${typeof raw === "string" ? raw.slice(0, 200) : "(unknown)"}`;
  }
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    if (args[key] === undefined) return `missing required property \`${key}\``;
  }
  const allowed = new Set(Object.keys(properties));
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) return `unexpected property \`${key}\``;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const expected = properties[key]?.type;
    if (typeof expected !== "string") continue;
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const matches =
      expected === actual ||
      (expected === "number" && actual === "number") ||
      (expected === "integer" && actual === "number" && Number.isInteger(value));
    if (!matches) return `\`${key}\` should be ${expected}, got ${actual}`;
  }
  return null;
}

function unknownTool(call: { id: string; name: string }): ToolResult {
  return {
    callId: call.id,
    name: call.name,
    ok: false,
    content: `unknown tool: ${call.name}`,
    error: "unknown-tool"
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

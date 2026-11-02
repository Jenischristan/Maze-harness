import type { HookResult, HookRegistry } from "./hookTypes.js";
import type { PermissionPolicy } from "./permissions.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { fetchTool } from "./fetch.js";
import { pageTool } from "./page.js";
import { readTool } from "./read.js";
import { globTool, grepTool } from "./search.js";
import { writeTool } from "./write.js";
import { DEFAULT_MAX_OUTPUT_BYTES } from "./limits.js";

export * from "./permissions.js";
export * from "./truncate.js";
export * from "./limits.js";
export * from "./hookTypes.js";
export { resetShells } from "./bash.js";
export { readTool, writeTool, editTool, bashTool, globTool, grepTool };

const BUILTIN_TOOLS: ToolDefinition[] = [readTool, grepTool, globTool, editTool, writeTool, bashTool, pageTool];

/** Tools that reach the network; registered only where a policy allows it. */
export const NETWORK_TOOLS: ToolDefinition[] = [fetchTool];

/** Every tool that may be registered, including network tools. */
const ALL_TOOLS: ToolDefinition[] = [...BUILTIN_TOOLS, ...NETWORK_TOOLS];

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = BUILTIN_TOOLS) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Add or replace a tool (used for MCP servers and plugins). */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Tool definitions formatted for a model request. */
  schema(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return this.list().map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
  }
}

const READ_ONLY = new Set(["read", "grep", "glob", "page", "fetch"]);

export interface ExecutorOptions {
  registry: ToolRegistry;
  workspaceDir: string;
  permission: PermissionPolicy;
  hooks: HookRegistry;
  maxOutputBytes?: number;
  /** Max repeated identical calls before loop detection trips. */
  loopThreshold?: number;
}

export interface ExecutedBatch {
  results: ToolResult[];
  hookResults: HookResult[];
  loopDetected: boolean;
}

/**
 * Executes tool calls. Independent read-only calls run in parallel; mutating
 * calls run sequentially so edit order is deterministic. After any mutating
 * call (edit/write/bash), verification hooks run once and their output is
 * attached to the batch.
 */
export class ToolExecutor {
  readonly readFiles = new Set<string>();
  readonly readHashes = new Map<string, string>();
  readonly modifiedFiles = new Set<string>();
  private readonly opts: ExecutorOptions;
  private readonly seen = new Map<string, number>();
  /** Abort signal for the current turn, forwarded to every tool. */
  private signal: AbortSignal | undefined;

  constructor(opts: ExecutorOptions) {
    this.opts = opts;
  }

  /**
   * Bind the turn's abort signal. Ctrl-C in the CLI aborts the controller; tools
   * receive the same signal through `ToolContext.signal` and kill their
   * subprocesses, so a 120s bash command does not have to run to completion.
   */
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
      signal: this.signal
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
      if (count > (this.opts.loopThreshold ?? 4) && !READ_ONLY.has(call.name)) {
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
      if (READ_ONLY.has(call.name)) parallelIdx.push(i);
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
      return { callId: call.id, name: call.name, ok: false, content: `tool error: ${message}`, error: message };
    }
  }
}

/**
 * Minimal structural validation against a tool's JSON Schema.
 *
 * The model's argument object was previously trusted blindly: a parse failure
 * became `{ __parseError: raw }` and the tool ran anyway (e.g. bash reported
 * "empty command"). Validate the required properties and their primitive
 * types, and reject stray keys when the schema says `additionalProperties:
 * false`, so the model gets a clear "invalid arguments" result instead of a
 * silent misinterpretation.
 */
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

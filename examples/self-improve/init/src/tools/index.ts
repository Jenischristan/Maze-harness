import type { HookResult, HookRegistry } from "./hookTypes.js";
import type { PermissionPolicy } from "./permissions.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";
import { globTool, grepTool } from "./search.js";
import { writeTool } from "./write.js";

export * from "./permissions.js";
export * from "./truncate.js";
export * from "./hookTypes.js";
export { verifyCommandsToHooks, Hooks } from "./hooks.js";
export { resetShells } from "./bash.js";
export { readTool, writeTool, editTool, bashTool, globTool, grepTool };

export const BUILTIN_TOOLS: ToolDefinition[] = [readTool, grepTool, globTool, editTool, writeTool, bashTool];

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(tools: ToolDefinition[] = BUILTIN_TOOLS) {
    for (const t of tools) this.tools.set(t.name, t);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
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

const READ_ONLY = new Set(["read", "grep", "glob"]);

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
  readonly modifiedFiles = new Set<string>();
  private readonly opts: ExecutorOptions;
  private readonly seen = new Map<string, number>();
  private networkDenied = false;

  constructor(opts: ExecutorOptions) {
    this.opts = opts;
  }

  context(): ToolContext {
    return {
      workspaceDir: this.opts.workspaceDir,
      readFiles: this.readFiles,
      modifiedFiles: this.modifiedFiles,
      maxOutputBytes: this.opts.maxOutputBytes ?? 32 * 1024,
      permission: this.opts.permission,
      hooks: this.opts.hooks
    };
  }

  async runBatch(
    calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  ): Promise<ExecutedBatch> {
    const ctx = this.context();
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
        if (this.networkDenied) {
          return { i, result: denied(call, "network disabled") };
        }
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
    if (mutated && this.opts.hooks.list().length > 0) {
      hookResults = await this.opts.hooks.runAll();
    }
    return { results: results.filter(Boolean), hookResults, loopDetected };
  }

  private async safeExecute(
    def: ToolDefinition,
    call: { id: string; name: string; arguments: Record<string, unknown> },
    ctx: ToolContext
  ): Promise<ToolResult> {
    try {
      const result = await def.execute(call.arguments, ctx);
      return { ...result, callId: call.id, name: call.name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { callId: call.id, name: call.name, ok: false, content: `tool error: ${message}`, error: message };
    }
  }
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

function denied(call: { id: string; name: string }, reason: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, content: `denied: ${reason}`, error: "permission-denied" };
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

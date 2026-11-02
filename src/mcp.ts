import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * Minimal Model Context Protocol (MCP) client over stdio.
 *
 * Only the pieces the harness needs are implemented: `initialize`,
 * `tools/list`, and `tools/call`, using newline-delimited JSON-RPC 2.0. This is
 * deliberately small and dependency-free, but wire-compatible with real MCP
 * servers (filesystem, git, sqlite, …).
 */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const MCP_CONFIG_FILES = [".dream/mcp.json", ".mcp.json", "mcp.json"];

/** Load `mcpServers` from the first config file that exists. */
export async function loadMcpConfig(root: string): Promise<McpServerConfig[]> {
  for (const rel of MCP_CONFIG_FILES) {
    const path = join(resolve(root), rel);
    if (!existsSync(path)) continue;
    const raw = await readFile(path, "utf8").catch(() => "");
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      const servers = parsed.mcpServers ?? {};
      const out: McpServerConfig[] = [];
      for (const [name, value] of Object.entries(servers)) {
        // `/init` writes a disabled `_example` entry. Anything whose name
        // starts with `_` is a template/comment, not a server to spawn.
        if (name.startsWith("_")) continue;
        const v = value as Record<string, unknown>;
        if (typeof v.command !== "string") continue;
        if (v.enabled === false) continue;
        out.push({
          name,
          command: v.command,
          args: Array.isArray(v.args) ? v.args.map(String) : [],
          env: v.env && typeof v.env === "object" ? (v.env as Record<string, string>) : undefined
        });
      }
      return out;
    } catch {
      // fall through to the next candidate
    }
  }
  return [];
}

export class McpClient {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;
  readonly name: string;
  private tools: McpToolInfo[] = [];

  private constructor(proc: ChildProcessWithoutNullStreams, name: string) {
    this.proc = proc;
    this.name = name;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    // Drain stderr: some servers are chatty and would otherwise block.
    proc.stderr.on("data", () => undefined);
    proc.on("exit", () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error(`mcp server ${name} exited`));
      this.pending.clear();
    });
  }

  static async connect(cfg: McpServerConfig, timeoutMs = 15_000): Promise<McpClient> {
    const proc = spawn(cfg.command, cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(cfg.env ?? {}) }
    }) as ChildProcessWithoutNullStreams;
    const client = new McpClient(proc, cfg.name);
    // A failed handshake must not leak the child: connectMcpServers records
    // the error and moves on, so an orphan would accumulate per `/mcp reload`.
    try {
      const init = (await client.request(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "dream-harness", version: "0.2.0" }
        },
        timeoutMs
      )) as { protocolVersion?: string } | null;
      void init;
      client.notify("notifications/initialized", {});
      const list = (await client.request("tools/list", {}, timeoutMs)) as
        | { tools?: Array<{ name?: string; description?: string; inputSchema?: Record<string, unknown> }> }
        | null;
      client.tools = (list?.tools ?? [])
        .filter((t) => typeof t.name === "string" && t.name.length > 0)
        .map((t) => ({
          name: t.name as string,
          description: t.description ?? "",
          inputSchema:
            t.inputSchema && typeof t.inputSchema === "object"
              ? t.inputSchema
              : { type: "object", properties: {} },
          server: cfg.name
        }));
      return client;
    } catch (err) {
      client.close();
      throw err;
    }
  }

  get toolInfos(): McpToolInfo[] {
    return this.tools;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // servers may log non-JSON to stdout; ignore
    }
    const id = typeof msg.id === "number" ? msg.id : null;
    if (id === null) return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (msg.error) waiter.reject(new Error(`mcp error ${msg.error.code}: ${msg.error.message}`));
    else waiter.resolve(msg.result ?? null);
  }

  private write(payload: unknown): void {
    if (this.closed) throw new Error(`mcp server ${this.name} is closed`);
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private notify(method: string, params: unknown): void {
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch {
      // best effort
    }
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`mcp ${this.name}.${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolvePromise(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rejectPromise(e);
        }
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<{ ok: boolean; text: string }> {
    try {
      const result = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as
        | { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
        | null;
      const parts = (result?.content ?? [])
        .map((c) => (typeof c.text === "string" ? c.text : ""))
        .filter((t) => t.length > 0);
      return { ok: !result?.isError, text: parts.join("\n") || "(no content)" };
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : String(err) };
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error(`mcp server ${this.name} closed`));
    this.pending.clear();
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch {
      // ignore
    }
  }
}

/** Wrap a connected MCP tool as a harness ToolDefinition. */
function mcpToolDefinition(client: McpClient, info: McpToolInfo): ToolDefinition {
  return {
    name: `mcp__${info.server}__${info.name}`.replace(/[^A-Za-z0-9_]/g, "_"),
    description: `[MCP:${info.server}] ${info.description || info.name}`,
    parameters: info.inputSchema,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const result = await client.callTool(info.name, args);
      return {
        callId: "",
        name: info.name,
        ok: result.ok,
        content: result.text,
        error: result.ok ? undefined : "mcp-tool-error"
      };
    }
  };
}

export interface McpConnectionResult {
  clients: McpClient[];
  tools: ToolDefinition[];
  errors: Array<{ server: string; message: string }>;
}

/** Connect every configured server; failures are reported, never thrown. */
export async function connectMcpServers(
  servers: McpServerConfig[],
  opts: { timeoutMs?: number } = {}
): Promise<McpConnectionResult> {
  const clients: McpClient[] = [];
  const tools: ToolDefinition[] = [];
  const errors: Array<{ server: string; message: string }> = [];
  for (const server of servers) {
    try {
      const client = await McpClient.connect(server, opts.timeoutMs ?? 15_000);
      clients.push(client);
      for (const info of client.toolInfos) tools.push(mcpToolDefinition(client, info));
    } catch (err) {
      errors.push({ server: server.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { clients, tools, errors };
}

/** Human-readable summary of connected servers/tools. */
export function mcpSummary(result: McpConnectionResult): string[] {
  const lines: string[] = [];
  if (result.clients.length === 0 && result.errors.length === 0) {
    return ["no MCP servers configured (.dream/mcp.json)"];
  }
  for (const c of result.clients) {
    lines.push(`✓ ${c.name}: ${c.toolInfos.length} tools`);
    for (const t of c.toolInfos) lines.push(`    ${t.name} — ${t.description.slice(0, 80)}`);
  }
  for (const e of result.errors) lines.push(`✗ ${e.server}: ${e.message}`);
  return lines;
}

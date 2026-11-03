import { resolve } from "node:path";
import { NETWORK_TOOLS, ToolRegistry } from "./tools/index.js";
import { subAgentTool } from "./subagents.js";
import { connectMcpServers, loadMcpConfig, type McpClient } from "./mcp.js";
import { discoverSkills, type Skill } from "./skills.js";
import type { PermissionPolicy } from "./tools/permissions.js";

/**
 * Build the tool registry used by every non-Dream agent path (`chat`,
 * `ToolAgent`).
 *
 * Historically each path constructed a bare `ToolRegistry`, so MCP servers,
 * skills, and the `delegate` sub-agent tool were not uniformly available. This
 * helper is the single place that assembles the full registry:
 *
 *   - builtin tools (read/grep/glob/edit/write/bash) — always
 *   - `delegate` sub-agent tool — always
 *   - MCP tools from `.dream/mcp.json` / `.mcp.json` — best effort
 *
 * Skills are not tools; they are prompt sections, so they are returned
 * alongside the registry for the caller to inject via `extraPrompt`.
 *
 * Every optional piece is best-effort: a broken MCP config or skill directory
 * must never prevent an agent from starting.
 */
export interface AgentToolset {
  registry: ToolRegistry;
  skills: Skill[];
  mcpClients: McpClient[];
  /** Non-fatal problems from MCP/skill discovery, for logging. */
  warnings: string[];
  /** Close any spawned MCP servers. */
  close(): void;
}

export interface AgentToolsetOptions {
  /** Directory MCP config and skills are discovered from. */
  workspaceDir: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;
  /** Skip MCP entirely (used by offline/sandboxed callers). */
  enableMcp?: boolean;
  /** Skip the `delegate` tool (sub-agents would recurse otherwise). */
  enableDelegate?: boolean;
  /** Permission policy inherited by delegated sub-agents. */
  permissionPolicy?: PermissionPolicy;
  /** Approval handler inherited by delegated sub-agents. */
  approve?: (input: {
    tool: string;
    pattern: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;
}

export async function buildAgentToolset(opts: AgentToolsetOptions): Promise<AgentToolset> {
  const workspaceDir = resolve(opts.workspaceDir);
  const registry = new ToolRegistry();
  const warnings: string[] = [];

  let skills: Skill[] = [];
  try {
    skills = await discoverSkills(workspaceDir);
  } catch (err) {
    warnings.push(`skills: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Network-capable tools are registered but gated by the permission policy
  // (`networkAllowed`), so an empty allowlist disables them at call time.
  for (const tool of NETWORK_TOOLS) registry.register(tool);

  if (opts.enableDelegate !== false) {
    registry.register(
      subAgentTool({
        workspaceDir,
        model: opts.model,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        contextWindow: opts.contextWindow,
        registry,
        permissionPolicy: opts.permissionPolicy,
        approve: opts.approve
      })
    );
  }

  let mcpClients: McpClient[] = [];
  if (opts.enableMcp !== false) {
    try {
      const servers = await loadMcpConfig(workspaceDir);
      if (servers.length > 0) {
        const result = await connectMcpServers(servers);
        mcpClients = result.clients;
        for (const tool of result.tools) registry.register(tool);
        for (const e of result.errors) warnings.push(`mcp ${e.server}: ${e.message}`);
      }
    } catch (err) {
      warnings.push(`mcp: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    registry,
    skills,
    mcpClients,
    warnings,
    close(): void {
      for (const client of mcpClients) client.close();
      mcpClients = [];
    }
  };
}

/** Render discovered skills as a compact system-prompt section. */
export function skillsPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = ["# Available skills", ""];
  for (const s of skills) {
    lines.push(`- ${s.name}: ${s.description}`);
  }
  lines.push(
    "",
    "These skills are available but not active. When one matches the task, follow its instructions; the user can also invoke one explicitly with /skill <name>."
  );
  return lines.join("\n");
}

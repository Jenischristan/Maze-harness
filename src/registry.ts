import { resolve } from "node:path";
import { NETWORK_TOOLS, ToolRegistry } from "./tools/index.js";
import { subAgentTool } from "./subagents.js";
import { connectMcpServers, loadMcpConfig, type McpClient } from "./mcp.js";
import { discoverSkills, type Skill } from "./skills.js";
import { discoverAgents, type AgentDefinition } from "./agents/definitions.js";
import type { PermissionPolicy } from "./tools/permissions.js";
import type { CostTracker } from "./cost.js";
import type { McpConfigEntry } from "./config.js";

export interface AgentToolset {
  registry: ToolRegistry;
  skills: Skill[];

  agents: AgentDefinition[];
  mcpClients: McpClient[];

  warnings: string[];

  close(): void;
}

export interface AgentToolsetOptions {
  workspaceDir: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  contextWindow?: number;

  enableMcp?: boolean;

  enableDelegate?: boolean;

  permissionPolicy?: PermissionPolicy;

  approve?: (input: {
    tool: string;
    pattern: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;

  mcpConfig?: Record<string, McpConfigEntry>;

  sessionsDir?: string;

  cost?: CostTracker;
}

function serversFromConfig(entries: Record<string, McpConfigEntry>): Array<{
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}> {
  const out: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }> = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (name.startsWith("_") || entry.enabled === false) continue;

    if (entry.type === "remote" || (!entry.command && entry.url)) continue;
    const cmd = entry.command;
    if (!cmd) continue;
    const argv = Array.isArray(cmd) ? cmd : [cmd, ...(entry.args ?? [])];
    if (argv.length === 0) continue;
    out.push({ name, command: argv[0]!, args: argv.slice(1), env: entry.env });
  }
  return out;
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

  for (const tool of NETWORK_TOOLS) registry.register(tool);

  let agents: AgentDefinition[] = [];
  try {
    agents = await discoverAgents(workspaceDir);
  } catch (err) {
    warnings.push(`agents: ${err instanceof Error ? err.message : String(err)}`);
  }

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
        approve: opts.approve,
        agents,
        sessionsDir: opts.sessionsDir,
        cost: opts.cost
      })
    );
  }

  let mcpClients: McpClient[] = [];
  if (opts.enableMcp !== false) {
    try {
      const fromFile = await loadMcpConfig(workspaceDir);
      const fromConfig = serversFromConfig(opts.mcpConfig ?? {});
      const seen = new Set(fromConfig.map((s) => s.name));
      const servers = [...fromConfig, ...fromFile.filter((s) => !seen.has(s.name))];
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
    agents,
    mcpClients,
    warnings,
    close(): void {
      for (const client of mcpClients) client.close();
      mcpClients = [];
    }
  };
}

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

export function agentsPrompt(agents: AgentDefinition[]): string {
  const subs = agents.filter((a) => a.mode === "subagent" && a.source !== "builtin");
  if (subs.length === 0) return "";
  return [
    "# Available sub-agents",
    "",
    ...subs.map((a) => `- ${a.name}: ${a.description}`),
    "",
    "Use the `delegate` tool to hand a self-contained task to one of them."
  ].join("\n");
}

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionRule {
  /** Tool name or "*" for any tool. */
  tool: string;
  /** Optional command/path pattern (regex source) matched against the primary arg. */
  pattern?: string;
  action: PermissionAction;
}

export interface PermissionPolicy {
  rules: PermissionRule[];
  defaultAction: PermissionAction;
  /** Called when a rule resolves to "ask". Return true to allow. */
  ask?: (input: {
    tool: string;
    pattern: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;
  /** Allowlisted network hosts. Empty means no network access. */
  networkAllowlist?: string[];
  /** Whether network access is permitted at all. */
  networkEnabled?: boolean;
}

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  defaultAction: "allow",
  rules: [
    { tool: "bash", pattern: "rm\\s+-rf\\s+/", action: "deny" },
    { tool: "bash", pattern: "sudo", action: "deny" },
    { tool: "bash", pattern: ":\\s*\\(\\)\\s*\\{", action: "deny" },
    { tool: "bash", pattern: "mkfs|dd\\s+if=|shutdown|reboot", action: "deny" },
    { tool: "bash", pattern: "git\\s+push", action: "ask" },
    { tool: "bash", pattern: "curl|wget|nc\\s|ssh\\s", action: "ask" }
  ]
};

export interface PermissionDecision {
  action: PermissionAction;
  reason: string;
}

function primaryArg(args: Record<string, unknown>): string {
  for (const key of ["command", "path", "pattern", "url"]) {
    const v = args[key];
    if (typeof v === "string") return v;
  }
  return JSON.stringify(args);
}

export async function decide(
  policy: PermissionPolicy,
  tool: string,
  args: Record<string, unknown>
): Promise<PermissionDecision> {
  const subject = primaryArg(args);
  for (const rule of policy.rules) {
    if (rule.tool !== "*" && rule.tool !== tool) continue;
    if (rule.pattern) {
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, "i");
      } catch {
        continue;
      }
      if (!re.test(subject)) continue;
    }
    const label = `rule ${rule.tool}${rule.pattern ? `:${rule.pattern}` : ""}`;
    if (rule.action === "ask" && policy.ask) {
      const ok = await policy.ask({ tool, pattern: subject, args });
      return { action: ok ? "allow" : "deny", reason: label };
    }
    return { action: rule.action, reason: label };
  }
  if (policy.defaultAction === "ask" && policy.ask) {
    const ok = await policy.ask({ tool, pattern: subject, args });
    return { action: ok ? "allow" : "deny", reason: "default ask" };
  }
  return { action: policy.defaultAction, reason: "default" };
}

export function networkAllowed(policy: PermissionPolicy, url: string): boolean {
  if (!policy.networkEnabled) return false;
  const allow = policy.networkAllowlist ?? [];
  if (allow.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return allow.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

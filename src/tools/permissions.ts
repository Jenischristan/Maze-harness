type PermissionAction = "allow" | "ask" | "deny";

interface PermissionRule {
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

/**
 * Default policy. Mutating tools default to `ask`, so a policy that never
 * wired an `ask` handler denies rather than silently allowing. Read-only
 * tools stay allowed.
 *
 * The deny list is defense-in-depth only — it is a handful of regexes and is
 * trivially bypassed by construction, so it must never be relied on as the
 * security boundary.
 */
export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  defaultAction: "ask",
  rules: [
    { tool: "read", action: "allow" },
    { tool: "grep", action: "allow" },
    { tool: "glob", action: "allow" },
    { tool: "page", action: "allow" },
    { tool: "bash", pattern: "rm\\s+-rf\\s+/", action: "deny" },
    { tool: "bash", pattern: "(?:^|[\\s;&|])(?:doas|pkexec|su\\s+-c|sudo)\\b", action: "deny" },
    { tool: "bash", pattern: ":\\s*\\(\\)\\s*\\{", action: "deny" },
    { tool: "bash", pattern: "mkfs|dd\\s+if=|shutdown|reboot", action: "deny" },
    { tool: "bash", pattern: "git\\s+clean\\s+-[a-z]*f", action: "ask" },
    { tool: "bash", pattern: "git\\s+push", action: "ask" },
    { tool: "bash", pattern: "curl|wget|\\bnc\\s|\\bssh\\s", action: "ask" }
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
      if (!patternMatches(rule.pattern, subject)) continue;
    }
    const label = `rule ${rule.tool}${rule.pattern ? `:${rule.pattern}` : ""}`;
    if (rule.action === "ask") {
      if (!policy.ask) return { action: "deny", reason: `${label} (no approval handler)` };
      const ok = await policy.ask({ tool, pattern: subject, args });
      return { action: ok ? "allow" : "deny", reason: label };
    }
    return { action: rule.action, reason: label };
  }
  if (policy.defaultAction === "ask") {
    // No handler wired: fail closed. An `ask` that silently allows would make
    // the whole permission layer advisory.
    if (!policy.ask) return { action: "deny", reason: "default ask (no approval handler)" };
    const ok = await policy.ask({ tool, pattern: subject, args });
    return { action: ok ? "allow" : "deny", reason: "default ask" };
  }
  return { action: policy.defaultAction, reason: "default" };
}

/**
 * Match a rule pattern against a subject.
 *
 * Patterns are user-supplied and were previously compiled and run verbatim, so
 * a catastrophic-backtracking pattern (e.g. `(a+)+$`) against a long `bash`
 * command could stall every permission decision. `safeRegExpTest` bounds the
 * work; an over-long subject is matched on a truncated prefix so the bound is
 * meaningful rather than `O(n)` per pattern.
 */
const MAX_SUBJECT_CHARS = 4096;

function patternMatches(pattern: string, subject: string): boolean {
  const input = subject.length > MAX_SUBJECT_CHARS ? subject.slice(0, MAX_SUBJECT_CHARS) : subject;
  return safeRegExpTest(pattern, input, "i");
}

/**
 * Time-bounded regex test.
 *
 * Node cannot interrupt a synchronous regex, so this cannot hard-cap a single
 * `test()` call. It does two things that matter in practice: (1) it validates
 * the pattern once so a malformed rule is skipped rather than throwing, and
 * (2) it runs the test on a bounded input, which is what actually keeps a
 * backtracking pattern from consuming the whole command line.
 */
function safeRegExpTest(pattern: string, input: string, flags: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return false;
  }
  try {
    return re.test(input);
  } catch {
    return false;
  }
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

type PermissionAction = "allow" | "ask" | "deny";

interface PermissionRule {
  tool: string;

  pattern?: string;
  action: PermissionAction;
}

export interface PermissionPolicy {
  rules: PermissionRule[];
  defaultAction: PermissionAction;

  ask?: (input: {
    tool: string;
    pattern: string;
    args: Record<string, unknown>;
  }) => Promise<boolean>;

  networkAllowlist?: string[];

  networkEnabled?: boolean;
}

export function splitCommands(command: string): string[][] {
  const out: string[][] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const flush = (): void => {
    const trimmed = cur.trim();
    if (trimmed) out.push(tokenizeSimple(trimmed));
    cur = "";
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (c === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ";" || c === "\n") {
      flush();
      continue;
    }
    if ((c === "&" || c === "|") && command[i + 1] === c) {
      flush();
      i += 1;
      continue;
    }
    if (c === "|") {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return out;
}

export function tokenizeSimple(text: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let has = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      has = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) tokens.push(cur);

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i += 1;
      continue;
    }
    if (t === "env" || t === "command" || t === "exec" || t === "nohup") {
      i += 1;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

const SAFE_TOOLS = new Set(["read", "grep", "glob", "ls", "page", "todo", "question", "lsp"]);

const NEVER_ALLOW: Array<{ tool: string; re: RegExp; label: string }> = [
  {
    tool: "bash",
    re: /^rm\b(?=.*(?:^|\s)-\S*r)(?=.*(?:^|\s)-\S*f)(?=.*\s\/)/,
    label: "recursive force delete of an absolute path"
  },

  {
    tool: "bash",
    re: /^(mkfs(\.[a-z0-9]+)?|mke2fs|wipefs|fdisk|parted)\b/,
    label: "filesystem tool"
  },
  { tool: "bash", re: /^dd\b.*\bof=\/dev\//, label: "raw device write" },
  { tool: "bash", re: /^(shutdown|reboot|halt|poweroff)\b/, label: "system power control" },

  { tool: "bash", re: /^(sudo|doas|pkexec|su)\b/, label: "privilege escalation" },

  { tool: "bash", re: /:\s*\(\s*\)\s*\{.*\}\s*;?\s*:/, label: "fork bomb" },
  { tool: "bash", re: /\b(curl|wget)\b.*\|\s*(ba)?sh\b/, label: "pipe download to shell" }
];

const ASK: Array<{ tool: string; re: RegExp; label: string }> = [
  { tool: "bash", re: /^git\s+clean\b.*\s-\S*f/, label: "git clean with force" },
  { tool: "bash", re: /^git\s+push\b/, label: "git push" },
  { tool: "bash", re: /^(curl|wget|nc|ncat|ssh|scp|rsync)\b/, label: "network command" },
  { tool: "bash", re: /^rm\b.*\s-\S*r/, label: "recursive delete" }
];

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  defaultAction: "ask",
  rules: []
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

function basename(command: string): string {
  const idx = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  return idx >= 0 ? command.slice(idx + 1) : command;
}

// Rewrite the leading token to its basename so `/usr/bin/sudo ls` and
// `./rm -rf /` are matched by rules anchored with `^`, exactly like `sudo ls`.
function normalizeSegment(tokens: string[]): string[] {
  if (tokens.length === 0) return tokens;
  const out = [...tokens];
  out[0] = basename(out[0]!);
  return out;
}

function bashDecision(command: string): { action: PermissionAction; reason: string } | null {
  const simple = splitCommands(command);
  if (simple.length === 0) return null;
  const segments = simple.map(normalizeSegment);
  // Shell wrappers that are followed by another program (`sh -c ...`,
  // `bash script.sh`) must keep their original name: normalizing the lead
  // token would rewrite the wrapper's argument, not just a path prefix.
  for (const tokens of segments) {
    const wrapper = tokens[0] ?? "";
    if (/^(?:ba|da|z|k)?sh$/.test(wrapper)) {
      for (const rule of NEVER_ALLOW) {
        if (rule.re.test(command)) return { action: "deny", reason: rule.label };
      }
    }
  }
  // The whole raw command is also checked so cross-segment patterns
  // (e.g. `curl ... | sh`) see the pipeline that splitCommands removed.
  const haystacks = [...segments.map((tokens) => tokens.join(" ")), command];
  for (const haystack of haystacks) {
    for (const rule of NEVER_ALLOW) {
      if (rule.re.test(haystack)) return { action: "deny", reason: rule.label };
    }
  }
  for (const haystack of haystacks) {
    for (const rule of ASK) {
      if (rule.re.test(haystack)) return { action: "ask", reason: rule.label };
    }
  }
  return null;
}

export async function decide(
  policy: PermissionPolicy,
  tool: string,
  args: Record<string, unknown>
): Promise<PermissionDecision> {
  const subject = primaryArg(args);
  const finish = async (action: PermissionAction, reason: string): Promise<PermissionDecision> => {
    if (action !== "ask") return { action, reason };
    if (!policy.ask) return { action: "deny", reason: `${reason} (no approval handler)` };
    const ok = await policy.ask({ tool, pattern: subject, args });
    return { action: ok ? "allow" : "deny", reason };
  };

  if (tool === "bash" && typeof args.command === "string") {
    const structural = bashDecision(args.command);
    if (structural) return finish(structural.action, structural.reason);
  }
  for (const rule of policy.rules) {
    if (rule.tool !== "*" && rule.tool !== tool) continue;
    if (rule.pattern && !patternMatches(rule.pattern, subject)) continue;
    const label = `rule ${rule.tool}${rule.pattern ? `:${rule.pattern}` : ""}`;
    return finish(rule.action, label);
  }
  if (SAFE_TOOLS.has(tool)) return { action: "allow", reason: "read-only tool" };
  return finish(policy.defaultAction, policy.defaultAction === "ask" ? "default ask" : "default");
}

const MAX_SUBJECT_CHARS = 4096;

const regexCache = new Map<string, RegExp | null>();

function cachedRegExp(pattern: string, flags: string): RegExp | null {
  const key = `${flags}\u0000${pattern}`;
  if (regexCache.has(key)) return regexCache.get(key)!;
  let re: RegExp | null;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    re = null;
  }
  if (regexCache.size > 512) regexCache.clear();
  regexCache.set(key, re);
  return re;
}

// Detect the classic catastrophic-backtracking shapes: a quantified group that
// itself contains a quantifier, e.g. (a+)+, (a|aa)*, (\d*)*. Such patterns are
// rejected instead of run, because a match cannot be interrupted and a short
// hostile command used to block the event loop for minutes.
export function isReDoSRisk(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== "(" || pattern[i - 1] === "\\") continue;
    let depth = 0;
    let inner = "";
    let j = i;
    for (; j < pattern.length; j += 1) {
      const c = pattern[j]!;
      if (c === "\\") {
        inner += c + (pattern[j + 1] ?? "");
        j += 1;
        continue;
      }
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      if (j > i) inner += c;
    }
    if (j >= pattern.length) return false;
    const after = pattern[j + 1] ?? "";
    const quantifiedGroup = after === "+" || after === "*" || after === "{";
    if (!quantifiedGroup) continue;
    // (a+)+, (\d*)*: an inner quantifier.
    if (/([+*]|\{\d*,\d*\})/.test(inner)) return true;
    // (a|aa)*: an ambiguous alternation is also exponential when the
    // quantified group also contains a quantifier.
    if ((inner.match(/\|/g) ?? []).length >= 1 && /[+*]/.test(inner)) return true;
    // (a|aa)*$ style: the bare alternation inside a starred group is enough
    // when the alternation branches overlap, so flag any alternation whose
    // branches share a prefix with an unbounded quantifier on the group.
    if (after === "*" && /\|/.test(inner)) return true;
  }
  return false;
}

function patternMatches(pattern: string, subject: string): boolean {
  const input = subject.length > MAX_SUBJECT_CHARS ? subject.slice(0, MAX_SUBJECT_CHARS) : subject;
  if (isReDoSRisk(pattern)) return false;
  return safeRegExpTest(pattern, input, "i");
}

function safeRegExpTest(pattern: string, input: string, flags: string): boolean {
  const re = cachedRegExp(pattern, flags);
  if (!re) return false;
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

export function applyPermissionMap(
  base: PermissionPolicy,
  map: Record<string, "allow" | "ask" | "deny">
): PermissionPolicy {
  const rules = Object.entries(map).map(([tool, action]) => ({ tool, action }));
  return { ...base, rules: [...rules, ...base.rules] };
}

export const REDACTED = "[REDACTED]";

const SECRET_ENV_PATTERN =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|AUTH)(?:_|$)/i;

interface Redactor {
  literal: string;
  replacement: string;
}

const redactors: Redactor[] = [];
let literalSnapshot = "";

function refreshLiterals(env: NodeJS.ProcessEnv): void {
  const current: Redactor[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;

    if (value.length < 8) continue;
    if (!SECRET_ENV_PATTERN.test(key) && !looksLikeSecret(value)) continue;
    current.push({ literal: value, replacement: `[REDACTED:${key}]` });
  }

  current.sort((a, b) => b.literal.length - a.literal.length);
  redactors.length = 0;
  redactors.push(...current);
  literalSnapshot = current.map((r) => r.literal).join("\u0000");
}

function looksLikeSecret(value: string): boolean {
  return (
    /^sk-[A-Za-z0-9_-]{16,}$/.test(value) ||
    /^gh[pousr]_[A-Za-z0-9]{20,}$/.test(value) ||
    /^AKIA[0-9A-Z]{16}$/.test(value) ||
    /^xox[baprs]-[A-Za-z0-9-]{10,}$/.test(value)
  );
}

function literals(): Redactor[] {
  const snapshot = Object.entries(process.env)
    .filter(([, v]) => typeof v === "string" && v.length >= 8)
    .map(([, v]) => v as string)
    .join("\u0000");
  if (snapshot !== literalSnapshot) refreshLiterals(process.env);
  return redactors;
}

interface RedactPattern {
  re: RegExp;
  replace: string | ((sub: string, ...groups: string[]) => string);
}

const PATTERNS: RedactPattern[] = [
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED
  },

  {
    re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_s, scheme) => `${scheme} ${REDACTED}`
  },

  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, replace: REDACTED },

  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: REDACTED },

  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },

  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },

  {
    re: /(["']?[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|authorization)[A-Za-z0-9_]*["']?)(\s*[=:]\s*)("([^"]{6,})"|'([^']{6,})'|([^\s"',;]{6,}))/gi,
    replace: (_s, key: string, sep: string, whole: string, dq?: string, sq?: string) => {
      const value = dq ?? sq ?? whole;
      if (/^\s*(?:Bearer|Basic|Token)\b/i.test(value)) return `${key}${sep}${value}`;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
      return `${key}${sep}${quote}${REDACTED}${quote}`;
    }
  }
];

export function redact(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  for (const r of literals()) {
    if (out.includes(r.literal)) out = out.split(r.literal).join(r.replacement);
  }
  for (const { re, replace } of PATTERNS) {
    const fresh = new RegExp(re.source, re.flags);
    out = out.replace(fresh, replace as never);
  }
  return out;
}

export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out as T;
  }
  return value;
}

export function containsSecret(text: string): boolean {
  if (!text) return false;
  for (const r of literals()) {
    if (text.includes(r.literal)) return true;
  }
  return false;
}

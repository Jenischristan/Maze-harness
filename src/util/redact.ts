/**
 * Secret redaction for anything the harness persists or prints.
 *
 * Sessions, transcripts, logs and run stores are written verbatim, so a bash
 * command that prints an env var (`env`, `echo $DREAM_API_KEY`), a provider
 * error that echoes an Authorization header, or a model that repeats a token
 * would persist the secret to disk forever. Every string that crosses a
 * persistence or logging boundary is passed through `redact`.
 *
 * Two layers:
 *   1. Known-literal redaction: the values of secret-looking environment
 *      variables (`DREAM_API_KEY`, `*_TOKEN`, `*SECRET*`, ...) are replaced
 *      wherever they appear, so an exact key is caught even in free text.
 *   2. Pattern redaction: common credential shapes (Bearer headers, `sk-...`
 *      keys, AWS keys, PEM private keys, `password=...`) are scrubbed even when
 *      the literal value is unknown to this process.
 *
 * Redaction is deliberately conservative: it can over-redact a word that looks
 * like a key, which is safe. It never throws.
 */

export const REDACTED = "[REDACTED]";

/** Environment variables whose values are treated as secrets. */
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
    // Short values would mangle ordinary prose ("ok", "1"), so only values
    // long enough to plausibly be credentials are scrubbed literally.
    if (value.length < 8) continue;
    if (!SECRET_ENV_PATTERN.test(key) && !looksLikeSecret(value)) continue;
    current.push({ literal: value, replacement: `[REDACTED:${key}]` });
  }
  // Longest first so a key that contains another key is fully removed.
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
  // Re-scan when the environment changed so a key loaded after module init
  // (dotenv-style) is still redacted.
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

/**
 * Order matters. The generic `key: value` rule runs *last*, otherwise it
 * would rewrite `Authorization: Bearer <token>` before the Bearer rule can
 * preserve the scheme word. The Bearer rule captures the scheme separately.
 */
const PATTERNS: RedactPattern[] = [
  // PEM private keys (whole block, before anything splits it).
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED
  },
  // Authorization: Bearer <token> / Basic <base64> / Token <token>
  {
    re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_s, scheme) => `${scheme} ${REDACTED}`
  },
  // OpenAI / Anthropic style keys
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, replace: REDACTED },
  // GitHub tokens
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: REDACTED },
  // AWS access key ids
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED },
  // Slack tokens
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: REDACTED },
  // Generic `key=value` / `key: value` for secret-looking names.
  //
  // The key may be bare (`DREAM_API_KEY=...`) or wrapped in quotes
  // (`"api_key": "..."` in JSON). The leading quote must be consumed *before*
  // the secret word, otherwise a JSON key never matches. The value is matched
  // by three explicit alternatives (double-quoted, single-quoted, bare) rather
  // than one regex with a backreference, because a single backreference cannot
  // cover both `key="value"` and `"key": "value"`.
  {
    re: /(["']?[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|authorization)[A-Za-z0-9_]*["']?)(\s*[=:]\s*)("([^"]{6,})"|'([^']{6,})'|([^\s"',;]{6,}))/gi,
    replace: (_s, key: string, sep: string, whole: string, dq?: string, sq?: string) => {
      // The Bearer/Basic/Token rule already ran and rewrote the value; if the
      // captured value still starts with a scheme word it was not an actual
      // token (e.g. the rule matched an unrelated word), so leave it intact.
      const value = dq ?? sq ?? whole;
      if (/^\s*(?:Bearer|Basic|Token)\b/i.test(value)) return `${key}${sep}${value}`;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
      return `${key}${sep}${quote}${REDACTED}${quote}`;
    }
  }
];

/**
 * Redact secrets from one string. Returns the input unchanged when there is
 * nothing to redact (cheap fast path for large tool outputs).
 */
export function redact(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;
  for (const r of literals()) {
    if (out.includes(r.literal)) out = out.split(r.literal).join(r.replacement);
  }
  for (const { re, replace } of PATTERNS) {
    // Rebuild the regex on every pass so a caller that reused a `PATTERNS`
    // entry cannot inherit a stale `lastIndex` from a previous invocation.
    const fresh = new RegExp(re.source, re.flags);
    out = out.replace(fresh, replace as never);
  }
  return out;
}

/** Redact every string inside an arbitrary JSON-like value, without mutating it. */
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

/** True when `text` currently contains any known secret literal. */
export function containsSecret(text: string): boolean {
  if (!text) return false;
  for (const r of literals()) {
    if (text.includes(r.literal)) return true;
  }
  return false;
}

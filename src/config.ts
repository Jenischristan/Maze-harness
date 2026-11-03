/**
 * Central runtime configuration.
 *
 * Precedence is explicit and documented: CLI flag > environment variable >
 * built-in default. There is no project config file and no file layer; the only
 * on-disk config is `.dream/mcp.json` for MCP servers (see `mcp.ts`), which is
 * not part of this resolution.
 *
 * Environment variables (all optional):
 *   DREAM_BASE_URL        OpenAI-compatible endpoint
 *   DREAM_API_KEY         provider key (never logged, never persisted raw)
 *   DREAM_AGENT_MODEL     default model id
 *   DREAM_CONTEXT_WINDOW  context window in tokens
 *   DREAM_LOG_LEVEL       debug | info | warn | error
 *   DREAM_LOG_FORMAT      text | json
 *
 * A few values used to be re-derived inline in several places (notably the
 * context window, hard-coded to 128_000 in some call sites while the provider
 * had its own value), which made accounting disagree with the provider.
 * Everything now goes through `resolveConfig`.
 */

const DEFAULT_CONTEXT_WINDOW = 128_000;

export const DEFAULT_BASE_URL = "http://127.0.0.1:8788/v1/chat/completions";
export const DEFAULT_MODEL = "deepseek-chat";

export interface ResolvedConfig {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  contextWindow: number;
  logLevel: string;
  logFormat: string;
}

export interface ConfigOverrides {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  contextWindow?: number;
  logLevel?: string;
  logFormat?: string;
}

function envNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid ${key}: ${raw} (expected a positive number)`);
  }
  return Math.floor(n);
}

/**
 * Resolve config with flag > env > default precedence. Throws on an invalid
 * env value instead of silently falling back, so a typo is visible.
 */
export function resolveConfig(
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfig {
  const envWindow = envNumber(env, "DREAM_CONTEXT_WINDOW");
  const flagWindow =
    typeof overrides.contextWindow === "number" &&
    Number.isFinite(overrides.contextWindow) &&
    overrides.contextWindow > 0
      ? Math.floor(overrides.contextWindow)
      : undefined;
  return {
    baseUrl: pick(overrides.baseUrl, env.DREAM_BASE_URL, DEFAULT_BASE_URL),
    apiKey: pickApiKey(overrides.apiKey, env),
    model: pick(overrides.model, env.DREAM_AGENT_MODEL, DEFAULT_MODEL),
    contextWindow: flagWindow ?? envWindow ?? DEFAULT_CONTEXT_WINDOW,
    logLevel: pick(overrides.logLevel, env.DREAM_LOG_LEVEL, "info"),
    logFormat: pick(overrides.logFormat, env.DREAM_LOG_FORMAT, "text")
  };
}

function pick(...values: Array<string | undefined>): string {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

/** API key resolution keeps the legacy aliases for compatibility. */
function pickApiKey(flag: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (typeof flag === "string" && flag.length > 0) return flag;
  return (
    (env.DREAM_API_KEY && env.DREAM_API_KEY.length > 0 ? env.DREAM_API_KEY : undefined) ??
    (env.DEEPSEEK_ROUTER_KEY && env.DEEPSEEK_ROUTER_KEY.length > 0
      ? env.DEEPSEEK_ROUTER_KEY
      : undefined) ??
    (env.OPENAI_API_KEY && env.OPENAI_API_KEY.length > 0 ? env.OPENAI_API_KEY : undefined)
  );
}

/** Resolve the context window from env/override, or the default. */
export function contextWindow(explicit?: number): number {
  return resolveConfig({ contextWindow: explicit }).contextWindow;
}

/** Default OpenAI-compatible endpoint used across chat/CLI. */
export function defaultBaseUrl(): string {
  return resolveConfig().baseUrl;
}

/** API key from the environment (never logs the value). */
export function defaultApiKey(): string | undefined {
  return resolveConfig().apiKey;
}

/** Default model name. */
export function defaultModel(): string {
  return resolveConfig().model;
}

/**
 * Token percentage against the real window. Clamped to [0, 1] so an overrun
 * (compaction lagging behind a burst) never prints >100% in the status bar.
 */
export function contextPct(tokens: number, window = contextWindow()): number {
  if (window <= 0) return 0;
  return Math.min(1, Math.max(0, tokens / window));
}

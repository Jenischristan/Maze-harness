/**
 * Central runtime configuration.
 *
 * A few values used to be re-derived inline in several places (notably the
 * context window, which was hard-coded to 128_000 in some call sites while
 * the provider had its own value). That made accounting disagree with the
 * provider and made changing the window a scavenger hunt. Everything that
 * needs the window now goes through `contextWindow()`.
 */

const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Resolve the context window from the environment, or the default. */
export function contextWindow(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const env = Number(process.env.DREAM_CONTEXT_WINDOW);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return DEFAULT_CONTEXT_WINDOW;
}

/** Default OpenAI-compatible endpoint used across chat/CLI. */
export function defaultBaseUrl(): string {
  return (
    process.env.DREAM_BASE_URL ?? "http://127.0.0.1:8788/v1/chat/completions"
  );
}

/** API key from the environment (never logs the value). */
export function defaultApiKey(): string | undefined {
  return (
    process.env.DREAM_API_KEY ??
    process.env.DEEPSEEK_ROUTER_KEY ??
    process.env.OPENAI_API_KEY
  );
}

/** Default model name. */
function defaultModel(): string {
  return process.env.DREAM_AGENT_MODEL ?? "deepseek-chat";
}

/**
 * Token percentage against the real window. Clamped to [0, 1] so an overrun
 * (compaction lagging behind a burst) never prints >100% in the status bar.
 */
export function contextPct(tokens: number, window = contextWindow()): number {
  if (window <= 0) return 0;
  return Math.min(1, Math.max(0, tokens / window));
}

export interface RetryPolicy {
  maxAttempts: number;

  baseDelayMs: number;

  maxDelayMs: number;

  jitter: number;

  retryable: (err: unknown) => boolean;

  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;

  signal?: AbortSignal;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitter: 0.2,
  retryable: () => true
};

export function isRetryableError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|timed out/i.test(
    message
  );
}

export function computeDelay(attempt: number, policy: RetryPolicy, random = Math.random): number {
  const raw = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(policy.maxDelayMs, raw);
  const factor = 1 + (random() * 2 - 1) * policy.jitter;
  return Math.max(0, Math.round(capped * factor));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: Partial<RetryPolicy> = {}
): Promise<T> {
  const p: RetryPolicy = { ...DEFAULT_RETRY, ...policy };
  if (!Number.isInteger(p.maxAttempts) || p.maxAttempts < 1) {
    throw new Error(`retry maxAttempts must be a positive integer, got ${p.maxAttempts}`);
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= p.maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= p.maxAttempts || !p.retryable(err)) throw err;
      const delayMs = computeDelay(attempt, p);
      p.onRetry?.({ attempt, delayMs, error: err });
      await sleep(delayMs, p.signal);
    }
  }
  throw lastError;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private stateValue: BreakerState = "closed";
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly now: () => number = Date.now
  ) {}

  get state(): BreakerState {
    this.refresh();
    return this.stateValue;
  }

  assertClosed(): void {
    this.refresh();
    if (this.stateValue === "open") {
      const remaining = Math.max(0, this.cooldownMs - (this.now() - this.openedAt));
      throw new Error(
        `circuit breaker open after ${this.failures} consecutive failures; retry in ${Math.ceil(remaining / 1000)}s`
      );
    }
  }

  recordSuccess(): void {
    this.failures = 0;
    this.stateValue = "closed";
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.stateValue = "open";
      this.openedAt = this.now();
    }
  }

  private refresh(): void {
    if (this.stateValue === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.stateValue = "half-open";
    }
  }
}

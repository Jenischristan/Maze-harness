export interface BudgetLimits {
  maxTurns?: number;

  maxTokens?: number;

  maxWallMs?: number;

  maxUsd?: number;

  maxToolCalls?: number;
}

export type BudgetKind = "turns" | "tokens" | "wall" | "usd" | "tool-calls";

export interface BudgetState {
  turns: number;
  tokens: number;
  usd: number;
  toolCalls: number;
  wallMs: number;
}

export interface BudgetExceeded {
  kind: BudgetKind;
  limit: number;
  used: number;
}

export class Budget {
  private readonly limits: BudgetLimits;
  private readonly startedAt: number;
  readonly used: BudgetState = { turns: 0, tokens: 0, usd: 0, toolCalls: 0, wallMs: 0 };

  constructor(limits: BudgetLimits, startedAt = Date.now()) {
    this.limits = limits;
    this.startedAt = startedAt;
  }

  turn(): void {
    this.used.turns += 1;
    this.refreshWall();
  }

  spend(tokens: number, usd: number): void {
    if (Number.isFinite(tokens) && tokens > 0) this.used.tokens += tokens;
    if (Number.isFinite(usd) && usd > 0) this.used.usd += usd;
    this.refreshWall();
  }

  toolCalls(n: number): void {
    if (Number.isFinite(n) && n > 0) this.used.toolCalls += n;
    this.refreshWall();
  }

  check(): BudgetExceeded | null {
    this.refreshWall();
    const { maxTurns, maxTokens, maxWallMs, maxUsd, maxToolCalls } = this.limits;
    if (typeof maxTurns === "number" && this.used.turns >= maxTurns) {
      return { kind: "turns", limit: maxTurns, used: this.used.turns };
    }
    if (typeof maxTokens === "number" && this.used.tokens >= maxTokens) {
      return { kind: "tokens", limit: maxTokens, used: this.used.tokens };
    }
    if (typeof maxWallMs === "number" && this.used.wallMs >= maxWallMs) {
      return { kind: "wall", limit: maxWallMs, used: this.used.wallMs };
    }
    if (typeof maxUsd === "number" && this.used.usd >= maxUsd) {
      return { kind: "usd", limit: maxUsd, used: this.used.usd };
    }
    if (typeof maxToolCalls === "number" && this.used.toolCalls >= maxToolCalls) {
      return { kind: "tool-calls", limit: maxToolCalls, used: this.used.toolCalls };
    }
    return null;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  private refreshWall(): void {
    this.used.wallMs = this.elapsedMs;
  }
}

export function describeBudgetExceeded(e: BudgetExceeded): string {
  const label =
    e.kind === "turns"
      ? "turn"
      : e.kind === "tokens"
        ? "token"
        : e.kind === "wall"
          ? "wall-clock"
          : e.kind === "usd"
            ? "USD"
            : "tool-call";
  return `budget exceeded: ${label} limit ${e.limit} (used ${Math.round(e.used * 10000) / 10000})`;
}

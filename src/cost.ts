import type { Usage } from "./types.js";

interface PricePerMillion {
  input: number;
  output: number;
}

const PRICES: Record<string, PricePerMillion> = {
  "deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "claude-3-5-sonnet": { input: 3, output: 15 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  local: { input: 0, output: 0 }
};

function priceFor(model: string): PricePerMillion {
  const direct = PRICES[model];
  if (direct) return direct;
  const key = Object.keys(PRICES).find((k) => model.includes(k));
  return key ? (PRICES[key] as PricePerMillion) : { input: 0, output: 0 };
}

export function usdFor(model: string, usage: Usage): number {
  const price = priceFor(model);
  return (
    (usage.promptTokens / 1_000_000) * price.input +
    (usage.completionTokens / 1_000_000) * price.output
  );
}

export interface CostTrackerOptions {
  model: string;
  /** Route exploration to a cheaper model (recorded, not enforced here). */
  explorationModel?: string;
}

export class CostTracker {
  readonly model: string;
  readonly explorationModel?: string;
  private promptTokens = 0;
  private completionTokens = 0;
  private usd = 0;
  private calls = 0;

  constructor(opts: CostTrackerOptions) {
    this.model = opts.model;
    this.explorationModel = opts.explorationModel;
  }

  record(usage: Usage, model = this.model): Usage {
    const usd = usage.usd ?? usdFor(model, usage);
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.usd += usd;
    this.calls += 1;
    return { ...usage, usd };
  }

  summary(): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    usd: number;
    calls: number;
  } {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      usd: this.usd,
      calls: this.calls
    };
  }
}

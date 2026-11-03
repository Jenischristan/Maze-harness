import type { Usage } from "./types.js";
import { modelInfo, priceUsage } from "./agent/models.js";

export function usdFor(model: string, usage: Usage): number {
  const info = modelInfo(model);
  return priceUsage(info, {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheReadTokens: usage.cacheReadTokens
  });
}

export interface CostTrackerOptions {
  model: string;

  explorationModel?: string;
}

export class CostTracker {
  readonly model: string;
  readonly explorationModel?: string;
  private promptTokens = 0;
  private completionTokens = 0;
  private cacheReadTokens = 0;
  private reasoningTokens = 0;
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
    this.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.reasoningTokens += usage.reasoningTokens ?? 0;
    this.usd += usd;
    this.calls += 1;
    return { ...usage, usd };
  }

  merge(other: CostTracker): void {
    const s = other.summary();
    this.promptTokens += s.promptTokens;
    this.completionTokens += s.completionTokens;
    this.cacheReadTokens += s.cacheReadTokens;
    this.reasoningTokens += s.reasoningTokens;
    this.usd += s.usd;
    this.calls += s.calls;
  }

  summary(): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    reasoningTokens: number;
    usd: number;
    calls: number;
  } {
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
      cacheReadTokens: this.cacheReadTokens,
      reasoningTokens: this.reasoningTokens,
      usd: this.usd,
      calls: this.calls
    };
  }
}

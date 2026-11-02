import type { PolicyDeveloper, ReplayReport } from "../types.js";

export interface FakePolicyDeveloperConfig {
  variants: string[];
}

export class FakePolicyDeveloper implements PolicyDeveloper {
  private readonly variants: string[];
  private index = 0;
  readonly calls: Array<{ replayReports: ReplayReport[]; previousFeedback: string[] }> = [];

  constructor(cfg: FakePolicyDeveloperConfig) {
    this.variants = cfg.variants;
  }

  async revise(input: {
    currentPolicySource: string;
    replayReports: ReplayReport[];
    previousFeedback: string[];
  }): Promise<string> {
    this.calls.push({
      replayReports: input.replayReports,
      previousFeedback: input.previousFeedback
    });
    if (this.variants.length === 0) return input.currentPolicySource;
    const source = this.variants[this.index % this.variants.length] as string;
    this.index += 1;
    return source;
  }
}

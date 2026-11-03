export interface ModelPricing {
  input: number;

  output: number;

  cacheRead?: number;

  cacheWrite?: number;
}

export interface ModelCapabilities {
  tools: boolean;

  streaming: boolean;

  reasoning: boolean;

  temperature: boolean;

  promptCache: boolean;

  reasoningContent: boolean;

  images: boolean;

  pdf: boolean;
}

export interface ModelInfo {
  provider: "openai" | "anthropic" | "responses" | "openai-compatible";

  contextWindow: number;

  maxOutputTokens: number;
  pricing: ModelPricing;
  capabilities: ModelCapabilities;

  label?: string;
}

const CAPS_BASE: ModelCapabilities = {
  tools: true,
  streaming: true,
  reasoning: false,
  temperature: true,
  promptCache: false,
  reasoningContent: false,
  images: false,
  pdf: false
};

function caps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return { ...CAPS_BASE, ...overrides };
}

interface FamilyRule {
  name: string;
  match: (id: string) => boolean;
  info: Omit<ModelInfo, "label">;
}

const ANTHROPIC_CAPS = caps({
  promptCache: true,
  reasoningContent: true,
  images: true,
  pdf: true
});

const OPENAI_CAPS = caps({ images: true, promptCache: true });

const RULES: FamilyRule[] = [
  {
    name: "claude-opus-4",
    match: (id) => /claude-opus-4/.test(id),
    info: {
      provider: "anthropic",
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      pricing: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
      capabilities: caps({ ...ANTHROPIC_CAPS, reasoning: true })
    }
  },
  {
    name: "claude-sonnet-4",
    match: (id) => /claude-sonnet-4/.test(id),
    info: {
      provider: "anthropic",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      capabilities: caps({ ...ANTHROPIC_CAPS, reasoning: true })
    }
  },
  {
    name: "claude-3-7-sonnet",
    match: (id) => /claude-3-7-sonnet/.test(id),
    info: {
      provider: "anthropic",
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      capabilities: caps({ ...ANTHROPIC_CAPS, reasoning: true })
    }
  },
  {
    name: "claude-3-5-sonnet",
    match: (id) => /claude-3-5-sonnet/.test(id),
    info: {
      provider: "anthropic",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      capabilities: ANTHROPIC_CAPS
    }
  },
  {
    name: "claude-3-5-haiku",
    match: (id) => /claude-3-5-haiku/.test(id),
    info: {
      provider: "anthropic",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      pricing: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
      capabilities: ANTHROPIC_CAPS
    }
  },

  {
    name: "gpt-5",
    match: (id) => /(^|[^a-z0-9])gpt-5/.test(id),
    info: {
      provider: "responses",
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      pricing: { input: 1.25, output: 10, cacheRead: 0.125 },
      capabilities: caps({
        ...OPENAI_CAPS,
        reasoning: true,
        reasoningContent: true,
        temperature: false
      })
    }
  },
  {
    name: "o3",
    match: (id) => /(^|[^a-z0-9])o3(-|$)/.test(id),
    info: {
      provider: "responses",
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      pricing: { input: 2, output: 8, cacheRead: 0.5 },
      capabilities: caps({
        ...OPENAI_CAPS,
        reasoning: true,
        reasoningContent: true,
        temperature: false
      })
    }
  },
  {
    name: "o4-mini",
    match: (id) => /(^|[^a-z0-9])o4-mini/.test(id),
    info: {
      provider: "responses",
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      pricing: { input: 1.1, output: 4.4, cacheRead: 0.275 },
      capabilities: caps({
        ...OPENAI_CAPS,
        reasoning: true,
        reasoningContent: true,
        temperature: false
      })
    }
  },
  {
    name: "o1",
    match: (id) => /(^|[^a-z0-9])o1(-|$)/.test(id),
    info: {
      provider: "responses",
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      pricing: { input: 15, output: 60, cacheRead: 7.5 },
      capabilities: caps({
        ...OPENAI_CAPS,
        reasoning: true,
        reasoningContent: true,
        temperature: false
      })
    }
  },

  {
    name: "gpt-4o",
    match: (id) => /gpt-4o/.test(id) && !/mini|audio|realtime/.test(id),
    info: {
      provider: "openai",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      pricing: { input: 2.5, output: 10, cacheRead: 1.25 },
      capabilities: OPENAI_CAPS
    }
  },
  {
    name: "gpt-4o-mini",
    match: (id) => /gpt-4o-mini/.test(id),
    info: {
      provider: "openai",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      pricing: { input: 0.15, output: 0.6, cacheRead: 0.075 },
      capabilities: OPENAI_CAPS
    }
  },

  {
    name: "deepseek-reasoner",
    match: (id) => /deepseek-(reasoner|r1)/.test(id),
    info: {
      provider: "openai-compatible",
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      pricing: { input: 0.55, output: 2.19, cacheRead: 0.14 },
      capabilities: caps({ reasoning: true, reasoningContent: true, temperature: false })
    }
  },
  {
    name: "deepseek-chat",
    match: (id) => /deepseek-(chat|v3)/.test(id),
    info: {
      provider: "openai-compatible",
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      pricing: { input: 0.27, output: 1.1, cacheRead: 0.07 },
      capabilities: caps()
    }
  }
];

function fallback(id: string): ModelInfo {
  const provider: ModelInfo["provider"] = /anthropic/.test(id)
    ? "anthropic"
    : /(^|\/)gpt-5|(^|\/)o[134]/.test(id)
      ? "responses"
      : "openai-compatible";
  return {
    provider,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    pricing: { input: 0, output: 0 },
    capabilities: caps(),
    label: id
  };
}

function normalise(id: string): string {
  const trimmed = id.trim().toLowerCase();

  const parts = trimmed.split(/[/:]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1]! : trimmed;
}

export function modelInfo(id: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  const key = normalise(id);
  const rule = RULES.find((r) => r.match(key));
  const base: ModelInfo = rule ? { ...rule.info, label: rule.name } : fallback(key);
  return {
    ...base,
    ...overrides,
    pricing: { ...base.pricing, ...(overrides.pricing ?? {}) },
    capabilities: { ...base.capabilities, ...(overrides.capabilities ?? {}) }
  };
}

export function priceUsage(
  info: Pick<ModelInfo, "pricing">,
  usage: { promptTokens: number; completionTokens: number; cacheReadTokens?: number }
): number {
  const p = info.pricing;
  const cacheRead = Math.min(usage.cacheReadTokens ?? 0, usage.promptTokens);
  const uncached = Math.max(0, usage.promptTokens - cacheRead);
  return (
    (uncached / 1_000_000) * p.input +
    (cacheRead / 1_000_000) * (p.cacheRead ?? p.input) +
    (usage.completionTokens / 1_000_000) * p.output
  );
}

export function knownModels(): Array<{ id: string; info: ModelInfo }> {
  return RULES.map((r) => ({ id: r.name, info: modelInfo(r.name) }));
}

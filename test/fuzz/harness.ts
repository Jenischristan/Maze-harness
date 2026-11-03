export interface Rng {
  next(): number;

  int(min: number, max: number): number;

  bool(p?: number): boolean;

  pick<T>(items: readonly T[]): T;

  shuffle<T>(items: readonly T[]): T[];

  str(maxLen?: number): string;

  weighted<T>(items: readonly T[], weights: readonly number[]): T;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[int(0, items.length - 1)]!;
  };
  return {
    next,
    int,
    bool: (p = 0.5) => next() < p,
    pick,
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
    str: (maxLen = 16) => {
      const alphabet = [
        "a",
        "b",
        "c",
        "X",
        "Y",
        "Z",
        "0",
        "1",
        "2",
        "3",
        " ",
        "_",
        "-",
        ".",
        "/",
        "\\",
        "\n",
        "\t",
        "\u00e9",
        "\u4e2d",
        "\ud83d\ude00"
      ];
      const len = int(0, maxLen);
      let s = "";
      for (let i = 0; i < len; i += 1) s += pick(alphabet);
      return s;
    },
    weighted: <T>(items: readonly T[], weights: readonly number[]): T => {
      if (items.length !== weights.length || items.length === 0) {
        throw new Error("weighted needs matching, non-empty lists");
      }
      const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
      if (total <= 0) return pick(items);
      let r = next() * total;
      for (let i = 0; i < items.length; i += 1) {
        r -= Math.max(0, weights[i]!);
        if (r < 0) return items[i]!;
      }
      return items[items.length - 1]!;
    }
  };
}

export function fuzzConfig(defaults: { seed?: number; runs?: number } = {}): {
  seed: number;
  runs: number;
} {
  const seed = Number(process.env.FUZZ_SEED ?? defaults.seed ?? 0x5eed);
  const runs = Number(process.env.FUZZ_RUNS ?? defaults.runs ?? 200);
  return {
    seed: Number.isFinite(seed) ? seed >>> 0 : 0x5eed,
    runs: Number.isFinite(runs) && runs > 0 ? Math.floor(runs) : 200
  };
}

export function fuzzCases(
  defaults: { seed?: number; runs?: number; maxRuns?: number },
  body: (rng: Rng, iteration: number) => void | Promise<void>
): () => Promise<void> {
  const { seed, runs } = fuzzConfig(defaults);

  const effective = defaults.maxRuns ? Math.min(runs, defaults.maxRuns) : runs;
  return async () => {
    for (let i = 0; i < effective; i += 1) {
      const caseSeed = (seed + i * 2654435761) >>> 0;
      const rng = makeRng(caseSeed);
      try {
        await body(rng, i);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const replay = `FUZZ_SEED=${caseSeed} (iteration ${i})`;
        const wrapped = new Error(`fuzz failure at ${replay}: ${message}`);
        (wrapped as Error & { cause?: unknown }).cause = err;
        throw wrapped;
      }
    }
  };
}

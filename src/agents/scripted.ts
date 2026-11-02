import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveryAgent, TaskSpec } from "../types.js";

export interface ScriptedAgentConfig {
  seed?: number;
  programFile?: string;
  failRate?: number;
  improvement?: number;
  noise?: number;
  tokensPerCall?: number;
}

function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ScriptedState {
  value: number;
  generation: number;
}

function readScriptedState(fileText: string): ScriptedState {
  try {
    const parsed = JSON.parse(fileText) as Partial<ScriptedState>;
    return {
      value: typeof parsed.value === "number" ? parsed.value : 0,
      generation: typeof parsed.generation === "number" ? parsed.generation : 0
    };
  } catch {
    return { value: 0, generation: 0 };
  }
}

export class ScriptedAgent implements DiscoveryAgent {
  private readonly cfg: Required<ScriptedAgentConfig>;

  constructor(cfg: ScriptedAgentConfig = {}) {
    this.cfg = {
      seed: cfg.seed ?? 1,
      programFile: cfg.programFile ?? "program.json",
      failRate: cfg.failRate ?? 0.1,
      improvement: cfg.improvement ?? 0.15,
      noise: cfg.noise ?? 0.2,
      tokensPerCall: cfg.tokensPerCall ?? 100
    };
  }

  async run(input: {
    workspaceDir: string;
    task: TaskSpec;
    parent: import("../types.js").DiscoveryNode | null;
    context: import("../types.js").AgentContext;
  }): Promise<{ transcriptPath?: string; tokens?: number }> {
    const path = join(input.workspaceDir, this.cfg.programFile);
    let state: ScriptedState = { value: 0, generation: 0 };
    try {
      state = readScriptedState(await readFile(path, "utf8"));
    } catch {
      state = { value: 0, generation: 0 };
    }
    const seed = hash(`${this.cfg.seed}:${input.context.nodeId}:${state.generation}`);
    const rnd = rngFrom(seed);
    const next: ScriptedState = {
      value: state.value + this.cfg.improvement + (rnd() - 0.5) * this.cfg.noise,
      generation: state.generation + 1
    };
    if (input.parent && !input.parent.valid) {
      next.value = state.value + this.cfg.improvement * 0.5;
    }
    if (rnd() < this.cfg.failRate) {
      next.value = -1;
    }
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return { tokens: this.cfg.tokensPerCall };
  }
}

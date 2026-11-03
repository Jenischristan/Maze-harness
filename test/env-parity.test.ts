import { describe, expect, it } from "vitest";
import { ReplayEnv } from "../src/env/replay.js";
import { ROOT_ID } from "../src/tree.js";
import { syntheticTree } from "./synthetic.js";

function tree() {
  return syntheticTree({
    seed: 13,
    branches: 3,
    refinements: 2,
    failRate: 0,
    baselineScore: 4,
    maxParallelism: 3,
    roundsLimit: 4
  });
}

describe("replay root-child parent delta", () => {
  it("measures a root child against the tree baseline", async () => {
    const t = tree();
    const firstRootChild = t.nodes
      .filter((n) => n.parentId === ROOT_ID)
      .sort((a, b) => a.seq - b.seq)[0]!;
    const env = new ReplayEnv(t, { maxRounds: 4 });
    const [obs] = await env.probeBatch([ROOT_ID]);
    expect(obs!.id).toBe(firstRootChild.id);
    const scale = Math.max(Math.abs(t.baselineScore), 1);
    const expected = (firstRootChild.score! - t.baselineScore) / scale;
    expect(obs!.deltaVsParent).toBeCloseTo(expected, 12);
    expect(obs!.improvedVsParent).toBe(firstRootChild.score! > t.baselineScore);
  });

  it("reset() clears the prefix without touching the recorded world", async () => {
    const t = tree();
    const env = new ReplayEnv(t, { maxRounds: 4 });
    await env.probeBatch([ROOT_ID]);
    const first = [...env.observed().values()];
    env.reset();
    expect(env.observed().size).toBe(0);
    expect(env.rounds).toBe(0);
    await env.probeBatch([ROOT_ID]);
    const again = [...env.observed().values()];
    expect(again.map((o) => o.id)).toEqual(first.map((o) => o.id));
    expect(again.map((o) => o.deltaVsParent)).toEqual(first.map((o) => o.deltaVsParent));
  });
});

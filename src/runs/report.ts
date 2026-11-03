import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveryTree } from "../types.js";

export interface RunRow {
  round: number;
  meanScore: number;
  cumulativeCalls: number;
}

export interface RunSummary {
  runId: string;
  mode: "dream" | "fixed";
  bestScore: number | null;
  totalCalls: number;
  rounds: RunRow[];
}

interface StateFile {
  mode?: string;
  results: Array<{
    round: number;
    meanScore: number;
    cumulativeCalls: number;
    treeIndex: number;
  }>;
}

export async function readRun(dir: string, runId: string): Promise<RunSummary | null> {
  const statePath = join(dir, runId, "state.json");
  if (!existsSync(statePath)) return null;
  let state: StateFile;
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as StateFile;
  } catch {
    return null;
  }
  // Prefer the mode the run recorded; older state files have no `mode`, so
  // fall back to the name prefix. An explicit `--run-id` need not carry the
  // prefix, so name-based detection alone silently dropped those runs from
  // `report` even though their state existed.
  const mode: "dream" | "fixed" =
    state.mode === "dream" || state.mode === "fixed"
      ? state.mode
      : runId.startsWith("dream")
        ? "dream"
        : "fixed";
  return {
    runId,
    mode,
    bestScore: await bestScore(join(dir, runId, "trees")),
    totalCalls: state.results.at(-1)?.cumulativeCalls ?? 0,
    rounds: state.results.map((r) => ({
      round: r.round,
      meanScore: r.meanScore,
      cumulativeCalls: r.cumulativeCalls
    }))
  };
}

export async function listRuns(dir: string): Promise<RunSummary[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const runs: RunSummary[] = [];
  // Discover by the presence of `state.json`, not by a name prefix: `--run-id`
  // accepts any identifier, and filtering on `dream-`/`fixed-` hid those runs.
  for (const entry of entries.sort()) {
    if (!existsSync(join(dir, entry, "state.json"))) continue;
    const run = await readRun(dir, entry);
    if (run) runs.push(run);
  }
  return runs;
}

export async function bestScore(treesDir: string): Promise<number | null> {
  let files: string[] = [];
  try {
    files = (await readdir(treesDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  let best: number | null = null;
  for (const f of files) {
    let tree: DiscoveryTree;
    try {
      tree = JSON.parse(await readFile(join(treesDir, f), "utf8")) as DiscoveryTree;
    } catch {
      continue;
    }
    for (const node of tree.nodes) {
      if (node.score === null) continue;
      if (best === null || node.score > best) best = node.score;
    }
  }
  return best;
}

export function renderComparison(runs: RunSummary[]): string {
  const lines: string[] = [];
  if (runs.length === 0) return "no runs found";
  const byMode = {
    fixed: runs.filter((r) => r.mode === "fixed"),
    dream: runs.filter((r) => r.mode === "dream")
  };
  lines.push("run                                    mode   best       calls  replay V by round");
  for (const run of runs) {
    lines.push(
      `${run.runId.padEnd(38)} ${run.mode.padEnd(6)} ${fmt(run.bestScore).padEnd(10)} ${String(run.totalCalls).padEnd(6)} ${run.rounds
        .map((r) => fmt(r.meanScore))
        .join(" ")}`
    );
  }
  lines.push("");
  for (const mode of ["fixed", "dream"] as const) {
    const group = byMode[mode];
    if (group.length === 0) continue;
    const best = group.map((r) => r.bestScore).filter((n): n is number => n !== null);
    const calls = group.map((r) => r.totalCalls);
    lines.push(
      `${mode.padEnd(6)} runs=${group.length}  mean best=${fmt(mean(best))}  mean calls=${fmt(mean(calls))}`
    );
  }
  lines.push("");
  lines.push("best score vs cumulative agent calls");
  for (const mode of ["fixed", "dream"] as const) {
    for (const run of byMode[mode]) {
      lines.push(`  ${mode} ${run.runId}: ${run.rounds.map((r) => `${r.cumulativeCalls}:${fmt(r.meanScore)}`).join("  ")}`);
    }
  }
  return lines.join("\n");
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(n: number | null): string {
  if (n === null) return "-";
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(4);
}

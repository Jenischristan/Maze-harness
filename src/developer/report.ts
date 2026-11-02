import { computeScore } from "../score.js";
import type {
  DiscoveryTree,
  FeedbackReport,
  ReplayReport,
  ReplayScoreConfig
} from "../types.js";

export function buildFeedbackReport(
  tree: DiscoveryTree,
  report: ReplayReport,
  config: ReplayScoreConfig
): FeedbackReport {
  const comp = computeScore({
    baselineScore: tree.baselineScore,
    revealedScores: report.revealed.map((o) => o.score),
    rounds: report.k,
    config
  });
  return {
    treeIndex: report.treeIndex,
    score: report.score,
    components: {
      best: comp.best,
      n: comp.n,
      k: comp.k,
      penalty: comp.penalty,
      bonus: comp.bonus
    },
    batches: report.batches,
    revealed: report.revealed,
    error: report.error
  };
}

export function renderFeedbackMarkdown(
  policyId: string,
  reports: ReplayReport[],
  trees: DiscoveryTree[],
  config: ReplayScoreConfig
): string {
  const lines: string[] = [];
  lines.push(`# Replay feedback for ${policyId}`);
  lines.push("");
  lines.push(
    `Score config: beta1=${config.beta1} beta2=${config.beta2} normalize=${config.normalize}`
  );
  lines.push("");
  for (const report of reports) {
    const tree = trees.find((t) => t.treeIndex === report.treeIndex);
    if (!tree) continue;
    const fb = buildFeedbackReport(tree, report, config);
    lines.push(`## Tree ${fb.treeIndex} (V = ${fmt(fb.score)})`);
    lines.push(
      `- components: best=${fmt(fb.components.best)} N=${fb.components.n} k=${fb.components.k} penalty=${fmt(fb.components.penalty)} bonus=${fmt(fb.components.bonus)}`
    );
    if (fb.error) lines.push(`- error: ${fb.error}`);
    lines.push(`- batches:`);
    for (const batch of fb.batches) lines.push(`  - [${batch.join(", ")}]`);
    lines.push(`- revealed:`);
    for (const obs of fb.revealed) {
      lines.push(
        `  - ${obs.id} branch=${obs.branch} attempt=${obs.attempt} score=${fmt(obs.score)} fail=${obs.failClass} dB=${fmt(obs.deltaVsBaseline)} dP=${fmt(obs.deltaVsParent)}`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function fmt(n: number | null): string {
  if (n === null) return "null";
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(4);
}

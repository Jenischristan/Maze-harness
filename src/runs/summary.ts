import { summarizeTree } from "../tree.js";
import type { DiscoveryTree, TreeSummary } from "../types.js";

export function summaryFromTree(tree: DiscoveryTree): TreeSummary {
  return summarizeTree(tree, [], tree.nodes.length > 0 ? tree.roundsLimit : 0);
}

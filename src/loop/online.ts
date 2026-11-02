import type { ExplorationPolicy } from "../types.js";
import type { LiveEnv } from "../env/live.js";

export async function runOnlineRollout(
  env: LiveEnv,
  policy: ExplorationPolicy
): Promise<void> {
  await policy.solve(env);
}

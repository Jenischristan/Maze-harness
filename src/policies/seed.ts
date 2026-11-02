import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const variantsDir = join(here, "variants");

export interface PolicySource {
  policyId: string;
  source: string;
}

/**
 * Returns the source of a built-in policy variant. Policy sources are plain,
 * self-contained modules (no imports) so they can be compiled with esbuild from
 * any working directory and run inside the replay sandbox.
 */
export async function loadVariantSource(
  name: "fixed" | "greedy",
  policyId: string = name
): Promise<PolicySource> {
  const raw = await readFile(join(variantsDir, `${name}.ts`), "utf8");
  return { policyId, source: raw };
}

export async function seedPolicySource(policyId = "fixed"): Promise<PolicySource> {
  const variant: "fixed" | "greedy" = policyId.startsWith("greedy") ? "greedy" : "fixed";
  return loadVariantSource(variant, policyId);
}

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function variantsDir(): string {
  const nextToHere = join(here, "variants");
  if (existsSync(join(nextToHere, "fixed.ts"))) return nextToHere;
  let dir = here;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json"))) {
      const candidate = join(dir, "src", "policies", "variants");
      if (existsSync(join(candidate, "fixed.ts"))) return candidate;
      break;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  return nextToHere;
}

export interface PolicySource {
  policyId: string;
  source: string;
}

export async function loadVariantSource(
  name: "fixed" | "greedy",
  policyId: string = name
): Promise<PolicySource> {
  const raw = await readFile(join(variantsDir(), `${name}.ts`), "utf8");
  return { policyId, source: raw };
}

export async function seedPolicySource(policyId = "fixed"): Promise<PolicySource> {
  const variant: "fixed" | "greedy" = policyId.startsWith("greedy") ? "greedy" : "fixed";
  return loadVariantSource(variant, policyId);
}

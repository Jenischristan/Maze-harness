import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the directory holding the import-free policy variants.
 *
 * Source runs (`tsx src/cli.ts`) resolve `src/policies/variants/` next to this
 * file. The bundled `dist/cli.js` is a single esbuild artifact with no copied
 * `variants/`, so fall back to walking up from the bundle location until the
 * package root (the directory with `package.json`) is found and read the
 * variants from `<root>/src/policies/variants/`.
 */
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
  // Last resort: keep the historical relative path so the error names the
  // path we expected.
  return nextToHere;
}

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
  const raw = await readFile(join(variantsDir(), `${name}.ts`), "utf8");
  return { policyId, source: raw };
}

export async function seedPolicySource(policyId = "fixed"): Promise<PolicySource> {
  const variant: "fixed" | "greedy" = policyId.startsWith("greedy") ? "greedy" : "fixed";
  return loadVariantSource(variant, policyId);
}

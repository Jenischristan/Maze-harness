import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

export interface CompileResult {
  ok: boolean;
  bundlePath: string | null;
  error: string | null;
}

export async function compilePolicy(opts: {
  source: string;
  outDir: string;
  policyId: string;
}): Promise<CompileResult> {
  await mkdir(opts.outDir, { recursive: true });
  const sourcePath = join(opts.outDir, `${opts.policyId}.ts`);
  const bundlePath = join(opts.outDir, `${opts.policyId}.mjs`);
  await writeFile(sourcePath, opts.source, "utf8");
  try {
    await build({
      entryPoints: [sourcePath],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      sourcemap: false,
      logLevel: "silent",
      external: ["node:*"]
    });
    return { ok: true, bundlePath, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, bundlePath: null, error: message };
  }
}

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the CLI version from the nearest `package.json`.
 *
 * The version used to be hardcoded as `0.1.0` while the package was `0.2.0`, so
 * `--version` lied in bug reports and release tooling. Walking up from this
 * module works both from `src/` (tsx) and from the bundled `dist/cli.js`, with
 * no build-time injection step to keep in sync.
 */
export async function versionFromCli(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let dir = here; ; dir = dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(await readFile(candidate, "utf8")) as { version?: unknown };
        if (typeof raw.version === "string" && raw.version.trim()) return raw.version;
      } catch {
        // fall through to the parent directory
      }
    }
    if (dirname(dir) === dir) return "0.0.0";
  }
}

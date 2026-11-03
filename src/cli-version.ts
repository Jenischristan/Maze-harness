import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function versionFromCli(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (let dir = here; ; dir = dirname(dir)) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(await readFile(candidate, "utf8")) as { version?: unknown };
        if (typeof raw.version === "string" && raw.version.trim()) return raw.version;
      } catch {
        void 0;
      }
    }
    if (dirname(dir) === dir) return "0.0.0";
  }
}

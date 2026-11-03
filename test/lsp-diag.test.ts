import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lspTool, parsePyOutput, parseTscOutput } from "../src/tools/lsp.js";
import type { ToolContext } from "../src/types.js";

let dir = "";
const realTsc = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-lsp2-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: dir,
    readFiles: new Set(),
    readHashes: new Map(),
    modifiedFiles: new Set(),
    maxOutputBytes: 32 * 1024,
    permission: { defaultAction: "allow", rules: [] },
    hooks: { register: () => undefined, list: () => [], runAll: async () => [] },
    ...overrides
  };
}

async function linkRealTypeScript(): Promise<boolean> {
  if (!existsSync(realTsc)) return false;
  await mkdir(join(dir, "node_modules", "typescript", "bin"), { recursive: true });
  await symlink(realTsc, join(dir, "node_modules", "typescript", "bin", "tsc"));
  await writeFile(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ["*.ts"]
    })
  );
  return true;
}

describe("lsp: with a real TypeScript compiler", () => {
  it("attributes a syntax error to the requested file only", async () => {
    if (!(await linkRealTypeScript())) return;
    await writeFile(join(dir, "a.ts"), "const x: number = ;\n");
    await writeFile(join(dir, "b.ts"), "const y: number = ;\n");
    const res = await lspTool.execute({ path: "a.ts" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("diagnostics");
    const diags = (res.data as { diagnostics: Array<{ file: string; code?: string }> }).diagnostics;
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.file === "a.ts")).toBe(true);
    expect(res.content).toMatch(/^a\.ts:1:\d+ error TS1109/);
  }, 180_000);

  it("reports no diagnostics for a clean file", async () => {
    if (!(await linkRealTypeScript())) return;
    await writeFile(join(dir, "clean.ts"), "export const ok: number = 1;\n");
    const res = await lspTool.execute({ path: "clean.ts" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toBe("no diagnostics for clean.ts");
  }, 180_000);

  it("caps the rendered diagnostics list", async () => {
    if (!(await linkRealTypeScript())) return;
    const lines = Array.from({ length: 60 }, (_, i) => `const v${i}: number = ;`).join("\n");
    await writeFile(join(dir, "many.ts"), `${lines}\n`);
    const res = await lspTool.execute({ path: "many.ts" }, ctx());
    if (res.ok) return;
    expect(res.content.split("\n").length).toBeLessThanOrEqual(50);
  }, 180_000);

  it("reports a checker failure when the tsconfig is invalid", async () => {
    if (!(await linkRealTypeScript())) return;
    await writeFile(join(dir, "tsconfig.json"), "{ not json");
    await writeFile(join(dir, "a.ts"), "const x = 1;\n");
    const res = await lspTool.execute({ path: "a.ts" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("checker-failed");
    expect(res.content).toContain("tsc failed");
  }, 180_000);

  it("honours an explicit deny rule before running the compiler", async () => {
    const res = await lspTool.execute(
      { path: "a.ts" },
      ctx({ permission: { defaultAction: "allow", rules: [{ tool: "lsp", action: "deny" }] } })
    );
    expect(res.error).toBe("permission-denied");
  });
});

describe("lsp: output parsers", () => {
  it("parses warnings and strips an exact workspace prefix", () => {
    const out = [
      "/ws/src/a.ts(2,5): warning TS6133: unused",
      "/ws/b.ts(1,1): error TS1005: ;",
      "noise"
    ].join("\n");
    expect(parseTscOutput(out, "/ws")).toEqual([
      {
        file: "src/a.ts",
        line: 2,
        column: 5,
        severity: "warning",
        code: "TS6133",
        message: "unused"
      },
      { file: "b.ts", line: 1, column: 1, severity: "error", code: "TS1005", message: ";" }
    ]);
  });

  it("ignores unrelated lines", () => {
    expect(parseTscOutput("", "/ws")).toEqual([]);
    expect(parsePyOutput("")).toEqual([]);
  });

  it("parses Python diagnostics with and without a code", () => {
    const d = parsePyOutput("a.py:1:2: F401 unused import\na.py:3:4: syntax error");
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ code: "F401", severity: "error" });
    expect(d[1]!.code).toBeUndefined();
  });
});

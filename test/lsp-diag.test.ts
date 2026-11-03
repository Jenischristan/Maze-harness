import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lspTool, parsePyOutput, parseTscOutput } from "../src/tools/lsp.js";
import type { ToolContext } from "../src/types.js";
import type { PermissionPolicy } from "../src/tools/permissions.js";

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

function perm(overrides: Partial<PermissionPolicy> = {}): PermissionPolicy {
  return { defaultAction: "allow", rules: [], ...overrides };
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

describe("lsp: output parsers", () => {
  it("parses tsc errors and warnings and strips an exact workspace prefix", () => {
    const out = [
      "/ws/a.ts(1,2): error TS1005: Expected ';'.",
      "/ws/b.ts(3,4): warning TS6133: unused.",
      "not a diagnostic",
      "/other/c.ts(5,6): error TS1: elsewhere"
    ].join("\n");
    const d = parseTscOutput(out, "/ws");
    expect(d).toEqual([
      {
        file: "a.ts",
        line: 1,
        column: 2,
        severity: "error",
        code: "TS1005",
        message: "Expected ';'."
      },
      { file: "b.ts", line: 3, column: 4, severity: "warning", code: "TS6133", message: "unused." },
      {
        file: "/other/c.ts",
        line: 5,
        column: 6,
        severity: "error",
        code: "TS1",
        message: "elsewhere"
      }
    ]);
  });

  it("parses pyflakes/ruff concise output with and without a code", () => {
    const d = parsePyOutput("a.py:1:2: E501 line too long\na.py:3:4: unexpected token");
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({
      file: "a.py",
      line: 1,
      column: 2,
      code: "E501",
      severity: "error"
    });
    expect(d[1]!.code).toBeUndefined();
    expect(d[1]!.message).toContain("unexpected token");
  });
});

describe("lsp: execute", () => {
  it("requires a path", async () => {
    const res = await lspTool.execute({}, ctx());
    expect(res.error).toBe("no-path");
  });

  it("honours an explicit deny rule", async () => {
    const res = await lspTool.execute(
      { path: "a.ts" },
      ctx({ permission: perm({ rules: [{ tool: "lsp", action: "deny" }] }) })
    );
    expect(res.error).toBe("permission-denied");
  });

  it("skips diagnostics when no checker is available for the extension", async () => {
    const res = await lspTool.execute({ path: "notes.md" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("no checker configured");
  });

  it("reports no diagnostics for a clean TypeScript file", async () => {
    await writeFile(join(dir, "clean.ts"), "export const x: number = 1;\n");
    const res = await lspTool.execute({ path: "clean.ts" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/no diagnostics|no TypeScript compiler found|tsc is not available/);
  }, 120_000);

  it("returns a compact diagnostics list for a broken file and filters by exact path", async () => {
    await writeFile(join(dir, "bad.ts"), "const x: number = ;\n");
    await writeFile(join(dir, "other.ts"), "const y = ;\n");
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
        include: ["*.ts"]
      })
    );
    const res = await lspTool.execute({ path: "bad.ts" }, ctx());
    if (res.content.includes("compiler found") || res.content.includes("not available")) return;
    expect(res.ok).toBe(false);
    expect(res.error).toBe("diagnostics");
    const diagnostics = (res.data as { diagnostics: Array<{ file: string }> }).diagnostics;
    expect(diagnostics.every((d) => d.file === "bad.ts")).toBe(true);
  }, 180_000);

  it("reports Python diagnostics or a clean result for a broken file", async () => {
    await writeFile(join(dir, "bad.py"), "def f(:\n  pass\n");
    const res = await lspTool.execute({ path: "bad.py" }, ctx());
    if (res.content.includes("no Python checker available")) return;
    if (res.error === "diagnostics") {
      expect(res.ok).toBe(false);
      expect(res.content.length).toBeGreaterThan(0);
      return;
    }
    // No ruff, but py_compile must have flagged the syntax error.
    expect(res.ok).toBe(false);
  }, 120_000);

  it("reports no diagnostics for valid Python", async () => {
    await writeFile(join(dir, "ok.py"), "print('ok')\n");
    const res = await lspTool.execute({ path: "ok.py" }, ctx());
    expect(res.ok).toBe(true);
  }, 120_000);
});

describe("lsp executable discovery", () => {
  it("does not crash when the lsp tool is invoked from a read-only workspace", async () => {
    await chmod(dir, 0o500);
    try {
      const res = await lspTool.execute({ path: "x.md" }, ctx());
      expect(res.ok).toBe(true);
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

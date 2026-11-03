import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ToolExecutor,
  ToolRegistry,
  applyPatchTool,
  editTool,
  multieditTool,
  readTool,
  writeTool,
  grepTool,
  globTool,
  bashTool,
  lspTool,
  resetShells
} from "../src/tools/index.js";
import { parseTscOutput } from "../src/tools/lsp.js";
import { Hooks } from "../src/tools/hooks.js";
import {
  decide,
  DEFAULT_PERMISSION_POLICY,
  type PermissionPolicy
} from "../src/tools/permissions.js";
import { truncateOutput, getPage } from "../src/tools/truncate.js";
import type { ToolContext } from "../src/types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-tools-"));
});

afterEach(async () => {
  resetShells();
  await rm(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: dir,
    readFiles: new Set(),
    modifiedFiles: new Set(),
    maxOutputBytes: 32 * 1024,
    permission: { ...DEFAULT_PERMISSION_POLICY, defaultAction: "allow" },
    hooks: new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 }),
    ...overrides
  };
}

async function read(path: string, c: ToolContext = ctx()): Promise<string> {
  const res = await readTool.execute({ path }, c);
  expect(res.ok).toBe(true);
  return res.content;
}

describe("read/write tools", () => {
  it("reads numbered lines with offset/limit", async () => {
    await writeFile(join(dir, "a.txt"), "l1\nl2\nl3\nl4\n");
    const text = await read("a.txt");
    expect(text).toContain("1\tl1");
    expect(text).toContain("4\tl4");
    const partial = await readTool.execute({ path: "a.txt", offset: 2, limit: 2 }, ctx());
    expect(partial.content).toBe("2\tl2\n3\tl3");
  });

  it("rejects paths that escape the workspace", async () => {
    const res = await readTool.execute({ path: "../../etc/passwd" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/escapes workspace/);
  });

  it("refuses to overwrite an unread file", async () => {
    await writeFile(join(dir, "x.txt"), "old");
    const res = await writeTool.execute({ path: "x.txt", content: "new" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("write-before-read");
    expect(await readFile(join(dir, "x.txt"), "utf8")).toBe("old");
  });

  it("allows overwrite after reading", async () => {
    await writeFile(join(dir, "x.txt"), "old");
    const c = ctx();
    await readTool.execute({ path: "x.txt" }, c);
    const res = await writeTool.execute({ path: "x.txt", content: "new", overwrite: true }, c);
    expect(res.ok).toBe(true);
    expect(await readFile(join(dir, "x.txt"), "utf8")).toBe("new");
  });

  it("still refuses overwrite:true for a file that was never read", async () => {
    await writeFile(join(dir, "x.txt"), "old");
    const res = await writeTool.execute({ path: "x.txt", content: "new", overwrite: true }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("write-before-read");
    expect(await readFile(join(dir, "x.txt"), "utf8")).toBe("old");
  });

  it("allows an unread clobber only with the explicit forceUnread escape hatch", async () => {
    await writeFile(join(dir, "x.txt"), "old");
    const res = await writeTool.execute(
      { path: "x.txt", content: "new", overwrite: true, forceUnread: true },
      ctx()
    );
    expect(res.ok).toBe(true);
    expect(await readFile(join(dir, "x.txt"), "utf8")).toBe("new");
  });

  it("creates nested directories for new files", async () => {
    const res = await writeTool.execute({ path: "a/b/c.txt", content: "hi" }, ctx());
    expect(res.ok).toBe(true);
    expect(existsSync(join(dir, "a/b/c.txt"))).toBe(true);
  });
});

describe("edit tool", () => {
  async function setup(content: string): Promise<ToolContext> {
    await writeFile(join(dir, "f.ts"), content);
    const c = ctx();
    await readTool.execute({ path: "f.ts" }, c);
    return c;
  }

  it("requires reading the file first", async () => {
    await writeFile(join(dir, "f.ts"), "hello");
    const res = await editTool.execute(
      { path: "f.ts", edits: [{ oldText: "hello", newText: "bye" }] },
      ctx()
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("edit-before-read");
  });

  it("applies multiple disjoint edits against the original", async () => {
    const c = await setup("const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const res = await editTool.execute(
      {
        path: "f.ts",
        edits: [
          { oldText: "const a = 1;", newText: "const a = 10;" },
          { oldText: "const c = 3;", newText: "const c = 30;" }
        ]
      },
      c
    );
    expect(res.ok).toBe(true);
    expect(await readFile(join(dir, "f.ts"), "utf8")).toBe(
      "const a = 10;\nconst b = 2;\nconst c = 30;\n"
    );
  });

  it("fails loudly when oldText is missing", async () => {
    const c = await setup("hello world");
    const res = await editTool.execute(
      { path: "f.ts", edits: [{ oldText: "nope", newText: "x" }] },
      c
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("oldText-not-found");
  });

  it("fails loudly when oldText is not unique", async () => {
    const c = await setup("x\nx\n");
    const res = await editTool.execute(
      { path: "f.ts", edits: [{ oldText: "x", newText: "y" }] },
      c
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("oldText-not-unique");
  });

  it("rejects overlapping edits", async () => {
    const c = await setup("abcdef");
    const res = await editTool.execute(
      {
        path: "f.ts",
        edits: [
          { oldText: "abcd", newText: "X" },
          { oldText: "cdef", newText: "Y" }
        ]
      },
      c
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("overlapping-edits");
  });

  it("replaces the whole fuzzy match, not just a prefix of it", async () => {
    // Regression: the indentation strategy matched lines with leading
    // whitespace stripped but returned a span computed from a stale offset,
    // so only a prefix of the intended block was replaced.
    const c = await setup("class A {\n    function f() {\n        return 1;\n    }\n}\n");
    const res = await editTool.execute(
      {
        path: "f.ts",
        edits: [
          {
            oldText: "function f() {\n  return 1;\n}",
            newText: "function f() {\n  return 2;\n}"
          }
        ]
      },
      c
    );
    expect(res.ok, res.content).toBe(true);
    expect(await readFile(join(dir, "f.ts"), "utf8")).toBe(
      "class A {\n    function f() {\n  return 2;\n}\n}\n"
    );
  });

  it("replaces a line-trimmed match including the real whitespace", async () => {
    // Regression: line-trimmed offsets were derived from the trimmed lines,
    // so the returned span was too short and left trailing spaces behind.
    const c = await setup("line one   \nline two\n");
    const res = await editTool.execute(
      {
        path: "f.ts",
        edits: [{ oldText: "line one\nline two", newText: "replaced" }]
      },
      c
    );
    expect(res.ok, res.content).toBe(true);
    expect(await readFile(join(dir, "f.ts"), "utf8")).toBe("replaced\n");
  });

  it("dryRun computes the result without writing to disk", async () => {
    // Regression: edit ignored dryRun and wrote immediately, which made
    // multiedit mutate earlier files before validating the rest.
    const c = await setup("hello\n");
    const res = await editTool.execute(
      { path: "f.ts", edits: [{ oldText: "hello", newText: "bye" }], dryRun: true },
      c
    );
    expect(res.ok).toBe(true);
    expect((res.data as { next: string }).next).toBe("bye\n");
    expect(await readFile(join(dir, "f.ts"), "utf8")).toBe("hello\n");
    expect(c.modifiedFiles.size).toBe(0);
  });
});

describe("multiedit tool", () => {
  async function twoFiles(): Promise<ToolContext> {
    await writeFile(join(dir, "a.txt"), "AAA\n");
    await writeFile(join(dir, "b.txt"), "BBB\n");
    const c = ctx();
    await readTool.execute({ path: "a.txt" }, c);
    await readTool.execute({ path: "b.txt" }, c);
    return c;
  }

  it("is atomic: a failing edit leaves every file untouched", async () => {
    const c = await twoFiles();
    const res = await multieditTool.execute(
      {
        files: [
          { path: "a.txt", edits: [{ oldText: "AAA", newText: "XXX" }] },
          { path: "b.txt", edits: [{ oldText: "NOPE", newText: "YYY" }] }
        ]
      },
      c
    );
    expect(res.ok).toBe(false);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("AAA\n");
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("BBB\n");
  });

  it("applies edits to every file on the success path", async () => {
    const c = await twoFiles();
    const res = await multieditTool.execute(
      {
        files: [
          { path: "a.txt", edits: [{ oldText: "AAA", newText: "one" }] },
          { path: "b.txt", edits: [{ oldText: "BBB", newText: "two" }] }
        ]
      },
      c
    );
    expect(res.ok, res.content).toBe(true);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("two\n");
  });

  it("rejects the same file listed twice under different paths", async () => {
    const c = await twoFiles();
    const res = await multieditTool.execute(
      {
        files: [
          { path: "a.txt", edits: [{ oldText: "AAA", newText: "one" }] },
          { path: "./a.txt", edits: [{ oldText: "AAA", newText: "two" }] }
        ]
      },
      c
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("multiedit-duplicate");
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("AAA\n");
  });
});

describe("apply_patch tool", () => {
  async function setup(files: Record<string, string>): Promise<ToolContext> {
    const c = ctx();
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
      await readTool.execute({ path: name }, c);
    }
    return c;
  }

  it("updates a file through an @@ hunk", async () => {
    const c = await setup({ "f.txt": "keep\nold line\ntail\n" });
    const patch = [
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@",
      "old line",
      "***NEW***",
      "new line",
      "*** End Patch"
    ].join("\n");
    const res = await applyPatchTool.execute({ patch }, c);
    expect(res.ok, res.content).toBe(true);
    expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("keep\nnew line\ntail\n");
  });

  it("deletes a file instead of truncating it", async () => {
    // Regression: Delete File wrote an empty file and left it on disk.
    const c = await setup({ "gone.txt": "bye\n" });
    const patch = ["*** Begin Patch", "*** Delete File: gone.txt", "*** End Patch"].join("\n");
    const res = await applyPatchTool.execute({ patch }, c);
    expect(res.ok, res.content).toBe(true);
    await expect(readFile(join(dir, "gone.txt"), "utf8")).rejects.toThrow();
  });

  it("creates a file that did not exist", async () => {
    const c = ctx();
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "first line",
      "second line",
      "*** End Patch"
    ].join("\n");
    const res = await applyPatchTool.execute({ patch }, c);
    expect(res.ok, res.content).toBe(true);
    expect(await readFile(join(dir, "new.txt"), "utf8")).toBe("first line\nsecond line");
  });

  it("leaves every file untouched when one hunk is invalid", async () => {
    const c = await setup({ "a.txt": "AAA\n", "b.txt": "BBB\n" });
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "AAA",
      "***NEW***",
      "changed",
      "*** Update File: b.txt",
      "@@",
      "NOPE",
      "***NEW***",
      "x",
      "*** End Patch"
    ].join("\n");
    const res = await applyPatchTool.execute({ patch }, c);
    expect(res.ok).toBe(false);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("AAA\n");
    expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("BBB\n");
  });

  it("refuses to patch a file that was never read", async () => {
    await writeFile(join(dir, "unread.txt"), "x\n");
    const patch = [
      "*** Begin Patch",
      "*** Update File: unread.txt",
      "@@",
      "x",
      "***NEW***",
      "y",
      "*** End Patch"
    ].join("\n");
    const res = await applyPatchTool.execute({ patch }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("patch-before-read");
  });
});

describe("search tools", () => {
  it("glob finds files recursively and skips node_modules", async () => {
    await writeFile(join(dir, "a.ts"), "");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/b.ts"), "");
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeFile(join(dir, "node_modules/c.ts"), "");
    const res = await globTool.execute({ pattern: "**/*.ts" }, ctx());
    const lines = res.content.split("\n");
    expect(lines).toContain("a.ts");
    expect(lines).toContain("src/b.ts");
    expect(lines).not.toContain("node_modules/c.ts");
  });

  it("grep reports file:line:match", async () => {
    await writeFile(join(dir, "a.ts"), "const x = 1;\nconst y = 2;\n");
    const res = await grepTool.execute({ pattern: "const y" }, ctx());
    expect(res.content).toContain("a.ts:2:const y = 2;");
  });

  it("grep honours glob filters", async () => {
    await writeFile(join(dir, "a.ts"), "needle");
    await writeFile(join(dir, "b.md"), "needle");
    const res = await grepTool.execute({ pattern: "needle", glob: "*.md" }, ctx());
    expect(res.content).toContain("b.md");
    expect(res.content).not.toContain("a.ts");
  });
});

describe("bash tool", () => {
  it("runs one-shot commands and reports exit status", async () => {
    const ok = await bashTool.execute({ command: "echo hello", persistent: false }, ctx());
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain("hello");
    const bad = await bashTool.execute({ command: "exit 3", persistent: false }, ctx());
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe("exit 3");
  });

  it("persists state across calls in the same session", async () => {
    resetShells();
    const ws = await mkdtemp(join(tmpdir(), "dh-shell-"));
    const c = ctx({ workspaceDir: ws });
    try {
      const first = await bashTool.execute({ command: "cd /tmp && X=42", timeoutMs: 5000 }, c);
      expect(first.ok).toBe(true);
      const res = await bashTool.execute({ command: "echo $X", timeoutMs: 5000 }, c);
      expect(res.content.trim()).toBe("42");
    } finally {
      resetShells();
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("times out long commands", async () => {
    const res = await bashTool.execute(
      { command: "sleep 5", persistent: false, timeoutMs: 300 },
      ctx()
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("timeout");
  }, 15000);

  it("denies commands matched by a deny rule", async () => {
    const policy: PermissionPolicy = {
      defaultAction: "allow",
      rules: [{ tool: "bash", pattern: "rm -rf", action: "deny" }]
    };
    const res = await bashTool.execute({ command: "rm -rf /tmp/x" }, ctx({ permission: policy }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("permission-denied");
  });
});

describe("permissions", () => {
  it("matches deny rules case-insensitively", async () => {
    const d = await decide(DEFAULT_PERMISSION_POLICY, "bash", { command: "SUDO ls" });
    expect(d.action).toBe("deny");
  });

  it("asks and honours the callback", async () => {
    const seen: string[] = [];
    const policy: PermissionPolicy = {
      defaultAction: "allow",
      rules: [{ tool: "bash", pattern: "curl", action: "ask" }],
      ask: async (input) => {
        seen.push(input.pattern);
        return false;
      }
    };
    const d = await decide(policy, "bash", { command: "curl example.com" });
    expect(d.action).toBe("deny");
    expect(seen).toEqual(["curl example.com"]);
  });
});

describe("lsp diagnostics", () => {
  it("parses tsc output and strips the workspace prefix", () => {
    const out = [
      "/proj/bad.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/ok.ts(2,3): warning TS9999: demo warning"
    ].join("\n");
    expect(parseTscOutput(out, "/proj")).toEqual([
      {
        file: "bad.ts",
        line: 1,
        column: 7,
        severity: "error",
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'."
      },
      {
        file: "src/ok.ts",
        line: 2,
        column: 3,
        severity: "warning",
        code: "TS9999",
        message: "demo warning"
      }
    ]);
  });

  it("does not attribute other files' diagnostics to the requested path", () => {
    // Regression: the filter used `output.includes(path)`, so requesting
    // `b.ts` also matched `ab.ts` and `src/sub/b.ts`.
    const out = "ab.ts(1,1): error TS1: boom.\nsrc/sub/b.ts(2,2): error TS2: other.\n";
    const want = "b.ts";
    const matched = parseTscOutput(out, "/proj").filter(
      (d) => d.file.split("\\").join("/").replace(/^\.\//, "") === want
    );
    expect(matched).toEqual([]);
  });

  it("runs without crashing in an ES module package", async () => {
    // Regression: the runner used `require("node:child_process")` inside an
    // ESM module and threw ERR_AMBIGUOUS_MODULE_SYNTAX on every call.
    await writeFile(join(dir, "notes.md"), "hello\n");
    const res = await lspTool.execute({ path: "notes.md" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("no checker configured");
  });
});

describe("truncation", () => {
  it("keeps the head and stores a retrievable page", () => {
    const text = "a".repeat(1000);
    const t = truncateOutput(text, 100, "head");
    expect(t.truncated).toBe(true);
    expect(t.pageToken).toBeDefined();
    expect(getPage(t.pageToken as string)).toBe(text);
    expect(t.text.startsWith("a".repeat(100))).toBe(true);
  });

  it("keeps the tail for errors", () => {
    const text = `${"x".repeat(500)}TAIL`;
    const t = truncateOutput(text, 100, "tail");
    expect(t.text.endsWith("TAIL")).toBe(true);
  });

  it("does nothing under the limit", () => {
    const t = truncateOutput("short", 100);
    expect(t.truncated).toBe(false);
  });
});

describe("tool executor", () => {
  it("runs read-only calls in parallel and mutating calls after", async () => {
    await writeFile(join(dir, "a.txt"), "a");
    await writeFile(join(dir, "b.txt"), "b");
    const registry = new ToolRegistry();
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 });
    const executor = new ToolExecutor({
      registry,
      workspaceDir: dir,
      permission: { ...DEFAULT_PERMISSION_POLICY, defaultAction: "allow" },
      hooks
    });
    const batch = await executor.runBatch([
      { id: "1", name: "read", arguments: { path: "a.txt" } },
      { id: "2", name: "read", arguments: { path: "b.txt" } },
      { id: "3", name: "write", arguments: { path: "c.txt", content: "c" } }
    ]);
    expect(batch.results).toHaveLength(3);
    expect(batch.results.every((r) => r.ok)).toBe(true);
    expect(existsSync(join(dir, "c.txt"))).toBe(true);
  });

  it("runs verification hooks after a mutation", async () => {
    const registry = new ToolRegistry();
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 });
    hooks.register({ name: "check", command: "test -f made.txt" });
    const executor = new ToolExecutor({
      registry,
      workspaceDir: dir,
      permission: { ...DEFAULT_PERMISSION_POLICY, defaultAction: "allow" },
      hooks
    });
    const batch = await executor.runBatch([
      { id: "1", name: "write", arguments: { path: "made.txt", content: "x" } }
    ]);
    expect(batch.hookResults).toHaveLength(1);
    expect(batch.hookResults[0]!.ok).toBe(true);
  });

  it("detects repeated mutating calls", async () => {
    const registry = new ToolRegistry();
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 });
    const executor = new ToolExecutor({
      registry,
      workspaceDir: dir,
      permission: { ...DEFAULT_PERMISSION_POLICY, defaultAction: "allow" },
      hooks,
      loopThreshold: 2
    });
    const call = { id: "1", name: "write", arguments: { path: "z.txt", content: "z" } };
    await executor.runBatch([call]);
    await executor.runBatch([call]);
    const third = await executor.runBatch([call]);
    expect(third.loopDetected).toBe(true);
    expect(third.results[0]!.error).toBe("loop");
  });

  it("returns unknown-tool errors instead of throwing", async () => {
    const registry = new ToolRegistry();
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 });
    const executor = new ToolExecutor({
      registry,
      workspaceDir: dir,
      permission: { ...DEFAULT_PERMISSION_POLICY, defaultAction: "allow" },
      hooks
    });
    const batch = await executor.runBatch([{ id: "1", name: "nope", arguments: {} }]);
    expect(batch.results[0]!.ok).toBe(false);
    expect(batch.results[0]!.error).toBe("unknown-tool");
  });
});

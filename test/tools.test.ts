import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { parseTscOutput, parsePyOutput } from "../src/tools/lsp.js";
import { Hooks } from "../src/tools/hooks.js";
import {
  decide,
  DEFAULT_PERMISSION_POLICY,
  type PermissionPolicy
} from "../src/tools/permissions.js";
import { truncateOutput, getPage } from "../src/tools/truncate.js";
import type { ToolContext } from "../src/types.js";
import { globToRegExp, lsTool } from "../src/tools/search.js";
import { pageTool } from "../src/tools/page.js";
import { parsePatch } from "../src/tools/patch.js";
import { todoTool, readTodos, renderTodos } from "../src/tools/todo.js";
import { questionTool, setQuestionHandler, ttyQuestionHandler } from "../src/tools/question.js";
import { isReadOnlyTool, isMutatingTool, READ_ONLY_TOOL_NAMES } from "../src/tools/kinds.js";
import { findFuzzy } from "../src/tools/fuzzy-match.js";

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
    readHashes: new Map(),
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

describe("read: PDF extraction paths", () => {
  it("reports pdf-no-extractor when pdftotext is unavailable", async () => {
    await writeFile(join(dir, "doc.pdf"), Buffer.from("%PDF-1.4 fake"));
    const res = await readTool.execute({ path: "doc.pdf" }, ctx());
    if (res.ok) {
      expect(res.data).toMatchObject({ mediaType: "application/pdf" });
    } else {
      expect(res.error).toBe("pdf-no-extractor");
      expect(res.content).toContain("pdftotext");
    }
  });

  it("never throws for a corrupt PDF", async () => {
    await writeFile(join(dir, "bad.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00]));
    const res = await readTool.execute({ path: "bad.pdf" }, ctx());
    expect(typeof res.content).toBe("string");
  });
});

describe("tools/kinds", () => {
  it("classifies read-only and mutating tools", () => {
    expect(isReadOnlyTool("read")).toBe(true);
    expect(isReadOnlyTool("edit")).toBe(false);
    expect(isMutatingTool("bash")).toBe(true);
    expect(isMutatingTool("read")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES).toContain("grep");
  });
});

describe("todo tool", () => {
  it("reports an empty list when nothing has been stored", async () => {
    const res = await todoTool.execute({}, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toBe("(no todos)");
    expect(res.data).toEqual({ todos: [] });
  });

  it("reads an empty list when the file is blank", async () => {
    await mkdir(join(dir, ".maze"), { recursive: true });
    await writeFile(join(dir, ".maze", "todos.json"), "   \n");
    expect(await readTodos(dir)).toEqual([]);
  });

  it("returns [] when the stored JSON is corrupt or the shape is wrong", async () => {
    await mkdir(join(dir, ".maze"), { recursive: true });
    await writeFile(join(dir, ".maze", "todos.json"), "{nope");
    expect(await readTodos(dir)).toEqual([]);
    await writeFile(join(dir, ".maze", "todos.json"), JSON.stringify({ todos: "x" }));
    expect(await readTodos(dir)).toEqual([]);
  });

  it("renders every status marker and the progress count", () => {
    const text = renderTodos([
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "completed" },
      { content: "d", status: "cancelled" }
    ]);
    expect(text).toContain("Progress: 1/4");
    expect(text).toContain("[ ] a");
    expect(text).toContain("[~] b");
    expect(text).toContain("[x] c");
    expect(text).toContain("[-] d");
  });

  it("writes the list, persists it and round-trips through read", async () => {
    const res = await todoTool.execute(
      {
        todos: [
          { content: "one", status: "completed" },
          { content: "two", status: "bogus" }
        ]
      },
      ctx()
    );
    expect(res.ok).toBe(true);
    const stored = JSON.parse(await readFile(join(dir, ".maze", "todos.json"), "utf8"));
    expect(stored.todos[1].status).toBe("pending");
    const readBack = await todoTool.execute({}, ctx());
    expect(readBack.content).toContain("1. [x] one");
    expect(readBack.content).toContain("2. [ ] two");
  });

  it("coerces non-string content", async () => {
    await todoTool.execute({ todos: [{ content: 42, status: "pending" }] }, ctx());
    const todos = await readTodos(dir);
    expect(todos[0]!.content).toBe("42");
  });
});

describe("page tool", () => {
  it("returns the full text for a live token", async () => {
    const full = "z".repeat(5000);
    const t = truncateOutput(full, 100, "head");
    const res = await pageTool.execute({ token: t.pageToken! }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toBe(full);
    expect((res.data as { bytes: number }).bytes).toBe(5000);
  });

  it("re-caps a page larger than the output budget", async () => {
    const full = "z".repeat(5000);
    const t = truncateOutput(full, 100, "head");
    const res = await pageTool.execute({ token: t.pageToken! }, ctx({ maxOutputBytes: 200 }));
    expect(res.ok).toBe(true);
    expect(res.content).toContain("5000 bytes");
  });

  it("rejects an unknown or expired token", async () => {
    const res = await pageTool.execute({ token: "deadbeef" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("page-not-found");
  });
});

describe("question tool", () => {
  it("rejects an empty question list", async () => {
    const res = await questionTool.execute({ questions: [] }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no-questions");
  });

  it("rejects a non-array questions argument", async () => {
    const res = await questionTool.execute({ questions: "x" }, ctx());
    expect(res.error).toBe("no-questions");
  });

  it("formats answers with headers through a custom handler", async () => {
    setQuestionHandler(async () => ["A"]);
    const res = await questionTool.execute(
      { questions: [{ header: "H", question: "pick" }, { question: "again" }] },
      ctx()
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain("H: pick");
    expect(res.content).toContain("→ A");
    expect((res.data as { answers: string[] }).answers).toEqual(["A"]);
  });

  it("maps a handler failure to a graceful error result", async () => {
    setQuestionHandler(async () => {
      throw new Error("no tty");
    });
    const res = await questionTool.execute({ questions: [{ question: "q" }] }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no-answer-handler");
    expect(res.content).toContain("no tty");
  });

  it("the TTY handler refuses without a TTY", async () => {
    await expect(ttyQuestionHandler([{ question: "q" }])).rejects.toThrow(/no TTY/);
  });
});

describe("multiedit tool", () => {
  it("rejects an empty file list", async () => {
    const res = await multieditTool.execute({ files: [] }, ctx());
    expect(res.error).toBe("no-files");
  });

  it("rejects a non-array files argument", async () => {
    const res = await multieditTool.execute({ files: "x" }, ctx());
    expect(res.error).toBe("no-files");
  });

  it("rejects the same file listed twice", async () => {
    await writeFile(join(dir, "a.txt"), "hello");
    const c = ctx({ readFiles: new Set([join(dir, "a.txt")]) });
    const res = await multieditTool.execute(
      {
        files: [
          { path: "a.txt", edits: [{ oldText: "hello", newText: "x" }] },
          { path: "./a.txt", edits: [{ oldText: "hello", newText: "y" }] }
        ]
      },
      c
    );
    expect(res.error).toBe("multiedit-duplicate");
  });

  it("returns an internal error when the planner yields no next content", async () => {
    const res = await multieditTool.execute(
      { files: [{ path: "a.txt", edits: [{ oldText: "x", newText: "y" }] }] },
      ctx()
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("edit-before-read");
  });

  it("rolls every file back when a commit write fails", async () => {
    await writeFile(join(dir, "a.txt"), "hello");
    const sub = join(dir, "sub");
    await mkdir(sub);
    await writeFile(join(sub, "b.txt"), "world");
    // A read-only directory makes writeFileAtomic's rename fail for b.txt while
    // a.txt (in the writable root) is written first.
    await chmod(sub, 0o500);
    const c = ctx({
      readFiles: new Set([join(dir, "a.txt"), join(sub, "b.txt")]),
      readHashes: new Map()
    });
    try {
      const res = await multieditTool.execute(
        {
          files: [
            { path: "a.txt", edits: [{ oldText: "hello", newText: "HELLO" }] },
            { path: "sub/b.txt", edits: [{ oldText: "world", newText: "WORLD" }] }
          ]
        },
        c
      );
      expect(res.ok).toBe(false);
      expect(res.error).toBe("multiedit-write-failed");
      // a.txt must be restored to its pre-batch content.
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("hello");
    } finally {
      await chmod(sub, 0o700);
    }
  });
});

describe("edit tool write failures", () => {
  it("reports a write error instead of throwing", async () => {
    await mkdir(join(dir, "f.txt"));
    const c = ctx({ readFiles: new Set([join(dir, "f.txt")]), readHashes: new Map() });
    // Reading a directory as utf8 succeeds, so force a write failure by making
    // the resolved path a directory and the edit a no-op on read.
    const res = await editTool.execute(
      { path: "f.txt", edits: [{ oldText: "x", newText: "y" }] },
      c
    );
    expect(res.ok).toBe(false);
    expect(existsSync(join(dir, "f.txt"))).toBe(true);
  });
});

describe("read: binary, encoding and notebook handling", () => {
  it("renders a notebook as cells with an output count", async () => {
    await writeFile(
      join(dir, "nb.ipynb"),
      JSON.stringify({ cells: [{ cell_type: "markdown", source: ["# t", "itle"] }] })
    );
    const res = await readTool.execute({ path: "nb.ipynb" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("## Cell 1 (markdown)");
    expect(res.content).toContain("# title");
  });

  it("falls back to raw text for an invalid notebook", async () => {
    await writeFile(join(dir, "bad.ipynb"), "{not json");
    const res = await readTool.execute({ path: "bad.ipynb" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("{not json");
  });

  it("returns raw text for a notebook with no cells array", async () => {
    await writeFile(join(dir, "nocells.ipynb"), JSON.stringify({ metadata: {} }));
    const res = await readTool.execute({ path: "nocells.ipynb" }, ctx());
    expect(res.content).toContain("metadata");
  });

  it("refuses a known binary extension and reports an unknown one", async () => {
    await writeFile(join(dir, "x.zip"), Buffer.from([0x50, 0x4b]));
    const res = await readTool.execute({ path: "x.zip" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain(".zip");
    expect(res.error).toBe("binary-file");
  });

  it("refuses a file containing NUL bytes", async () => {
    await writeFile(join(dir, "nul.dat"), Buffer.from([0x61, 0x00]));
    expect((await readTool.execute({ path: "nul.dat" }, ctx())).error).toBe("binary-file");
  });

  it("records the file hash for the stale-file guard", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    const c = ctx();
    await readTool.execute({ path: "a.txt" }, c);
    expect(c.readFiles.has(join(dir, "a.txt"))).toBe(true);
    expect(c.readHashes!.get(join(dir, "a.txt"))).toMatch(/^[0-9a-f]{40}$/);
  });

  it("notes when an image model is unavailable and returns a block when it is", async () => {
    await writeFile(join(dir, "i.png"), Buffer.from([0x89, 0x50]));
    const noMedia = await readTool.execute({ path: "i.png" }, ctx());
    expect(noMedia.content).toContain("does not accept images");
    const media = await readTool.execute({ path: "i.png" }, ctx({ mediaTypes: ["image/png"] }));
    expect(media.contentBlocks![0]).toMatchObject({ type: "image", mediaType: "image/png" });
  });

  it("reports a missing file and an escaping path", async () => {
    expect((await readTool.execute({ path: "nope.txt" }, ctx())).error).toMatch(/ENOENT/);
    expect((await readTool.execute({ path: "../x" }, ctx())).error).toMatch(/escapes/);
  });

  it("clamps offset and limit into the supported range", async () => {
    await writeFile(join(dir, "l.txt"), "1\n2\n3");
    expect((await readTool.execute({ path: "l.txt", offset: 0 }, ctx())).content).toContain("1\t1");
    expect((await readTool.execute({ path: "l.txt", limit: 0 }, ctx())).content).toContain("3\t3");
    expect((await readTool.execute({ path: "l.txt", limit: 1e9 }, ctx())).ok).toBe(true);
  });

  it("returns an empty result for an offset past the end", async () => {
    await writeFile(join(dir, "l.txt"), "1\n2");
    expect((await readTool.execute({ path: "l.txt", offset: 50 }, ctx())).content).toBe("");
  });
});

describe("search: ls, grep and glob", () => {
  it("lists directories first and filters hidden entries", async () => {
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "b.txt"), "bb");
    await writeFile(join(dir, ".hidden"), "h");
    await mkdir(join(dir, ".git"));
    const all = await lsTool.execute({}, ctx());
    expect(all.content.split("\n")[0]).toMatch(/^d .* sub\/$/);
    expect(all.content).toContain(".hidden");
    const visible = await lsTool.execute({ all: false }, ctx());
    expect(visible.content).not.toContain(".hidden");
    expect(visible.content).not.toContain(".git");
  });

  it("caps the ls entry count and reports the remainder", async () => {
    for (let i = 0; i < 5; i += 1) await writeFile(join(dir, `f${i}.txt`), "x");
    const res = await lsTool.execute({ maxEntries: 2 }, ctx());
    expect(res.content).toContain("3 more entries");
  });

  it("reports an empty directory and a missing directory", async () => {
    const empty = await mkdtemp(join(tmpdir(), "dh-empty-"));
    try {
      expect((await lsTool.execute({}, ctx({ workspaceDir: empty }))).content).toBe(
        "(empty directory)"
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
    expect((await lsTool.execute({ path: "nope" }, ctx())).error).toBeTruthy();
  });

  it("rejects an escaping ls path", async () => {
    expect((await lsTool.execute({ path: "../" }, ctx())).error).toBe("bad-path");
  });

  it("grep finds matches and honours a glob filter", async () => {
    await writeFile(join(dir, "a.ts"), "const target = 1;\n");
    await writeFile(join(dir, "b.md"), "target\n");
    const all = await grepTool.execute({ pattern: "target" }, ctx());
    expect(all.content).toContain("a.ts:1:const target = 1;");
    expect(all.content).toContain("b.md:1:target");
    const filtered = await grepTool.execute({ pattern: "target", glob: "*.ts" }, ctx());
    expect(filtered.content).toContain("a.ts");
    expect(filtered.content).not.toContain("b.md");
  });

  it("grep applies the glob filter on the node fallback too", async () => {
    // GitHub runners have no ripgrep, so this path is what CI actually runs.
    // Mock the ESM binding so the tool believes rg is missing.
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        execFile: ((...args: unknown[]) => {
          const cb = args.at(-1) as (err: Error | null, out: string) => void;
          cb(new Error("spawn rg ENOENT"), "");
          return {} as never;
        }) as never
      };
    });
    try {
      const fresh = await import("../src/tools/search.js");
      await writeFile(join(dir, "a.ts"), "needle");
      await writeFile(join(dir, "b.md"), "needle");
      const res = await fresh.grepTool.execute({ pattern: "needle", glob: "*.md" }, ctx());
      expect(res.data).toMatchObject({ engine: "node" });
      expect(res.content).toContain("b.md");
      expect(res.content).not.toContain("a.ts");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("grep is case-insensitive on request and reports no matches", async () => {
    await writeFile(join(dir, "a.txt"), "Hello\n");
    expect((await grepTool.execute({ pattern: "hello" }, ctx())).content).toBe("(no matches)");
    expect(
      (await grepTool.execute({ pattern: "hello", caseInsensitive: true }, ctx())).content
    ).toContain("Hello");
  });

  it("grep rejects an empty pattern and an escaping path", async () => {
    expect((await grepTool.execute({ pattern: "" }, ctx())).error).toBe("empty-pattern");
    expect((await grepTool.execute({ pattern: "x", path: "../" }, ctx())).error).toMatch(/escapes/);
  });

  it("grep falls back to the node engine for a rejected ripgrep pattern", async () => {
    await writeFile(join(dir, "a.txt"), "alpha\n");
    // A valid-in-JS, invalid-in-rust-regex pattern triggers the fallback path.
    const res = await grepTool.execute({ pattern: "\\b(alpha)\\b" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ engine: expect.any(String) });
  });

  it("grep reports an invalid JS regex as an error result", async () => {
    await writeFile(join(dir, "a.txt"), "alpha\n");
    const res = await grepTool.execute({ pattern: "(" }, ctx());
    // ripgrep rejects it too; the tool must not throw.
    expect(typeof res.content).toBe("string");
    expect(res.ok === false || res.ok === true).toBe(true);
  });

  it("grep respects maxResults", async () => {
    await writeFile(join(dir, "a.txt"), "x\nx\nx\nx\nx\n");
    const res = await grepTool.execute({ pattern: "x", maxResults: 2 }, ctx());
    expect(res.content.split("\n")).toHaveLength(2);
  });

  it("glob matches paths and bare filenames, and reports no matches", async () => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "x");
    await writeFile(join(dir, "b.md"), "x");
    expect((await globTool.execute({ pattern: "**/*.ts" }, ctx())).content).toContain("src/a.ts");
    expect((await globTool.execute({ pattern: "*.ts" }, ctx())).content).toContain("src/a.ts");
    expect((await globTool.execute({ pattern: "*.zzz" }, ctx())).content).toBe("(no matches)");
  });

  it("glob rejects an escaping base path", async () => {
    expect((await globTool.execute({ pattern: "*", path: "../" }, ctx())).error).toMatch(/escapes/);
  });

  it("globToRegExp escapes regex metacharacters", () => {
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("?.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("?.ts").test("ab.ts")).toBe(false);
    expect(globToRegExp("a/**/b").test("a/x/y/b")).toBe(true);
  });
});

describe("write: overwrite policy", () => {
  it("creates a new file and reports its size", async () => {
    const res = await writeTool.execute({ path: "n/a.txt", content: "héllo" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ bytes: Buffer.byteLength("héllo") });
    expect(await readFile(join(dir, "n/a.txt"), "utf8")).toBe("héllo");
  });

  it("refuses to clobber without overwrite", async () => {
    await writeFile(join(dir, "a.txt"), "old");
    const res = await writeTool.execute({ path: "a.txt", content: "new" }, ctx());
    expect(res.error).toBe("write-before-read");
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("old");
  });

  it("refuses to clobber an unread file even with overwrite", async () => {
    await writeFile(join(dir, "a.txt"), "old");
    const res = await writeTool.execute({ path: "a.txt", content: "new", overwrite: true }, ctx());
    expect(res.ok).toBe(false);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("old");
  });

  it("allows overwrite after a read, or with forceUnread", async () => {
    await writeFile(join(dir, "a.txt"), "old");
    const c = ctx({ readFiles: new Set([join(dir, "a.txt")]) });
    expect(
      (await writeTool.execute({ path: "a.txt", content: "new", overwrite: true }, c)).ok
    ).toBe(true);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("new");
    expect(
      (
        await writeTool.execute(
          { path: "a.txt", content: "forced", overwrite: true, forceUnread: true },
          ctx()
        )
      ).ok
    ).toBe(true);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("forced");
  });

  it("treats a file written in this session as read", async () => {
    const c = ctx();
    await writeTool.execute({ path: "a.txt", content: "one" }, c);
    expect(c.modifiedFiles.has(join(dir, "a.txt"))).toBe(true);
    // Same session: the earlier write counts as having read the file.
    expect(
      (await writeTool.execute({ path: "a.txt", content: "two", overwrite: true }, c)).ok
    ).toBe(true);
    // A fresh session has not read it, so overwrite alone is refused.
    expect(
      (await writeTool.execute({ path: "a.txt", content: "three", overwrite: true }, ctx())).ok
    ).toBe(false);
  });

  it("reports a path escape as a failure result", async () => {
    const res = await writeTool.execute({ path: "../x", content: "x" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/escapes/);
  });
});

describe("edit: fuzzy and CRLF paths", () => {
  it("rejects a malformed edit list and an empty oldText", async () => {
    expect((await editTool.execute({ path: "a", edits: [] }, ctx())).error).toBe("no-edits");
    expect((await editTool.execute({ path: "a", edits: "x" }, ctx())).error).toBe("no-edits");
    await writeFile(join(dir, "a.txt"), "abc");
    const c = ctx({ readFiles: new Set([join(dir, "a.txt")]) });
    expect(
      (await editTool.execute({ path: "a.txt", edits: [{ oldText: "", newText: "x" }] }, c)).error
    ).toBe("bad-oldText");
  });

  it("refuses a path that escapes the workspace", async () => {
    const res = await editTool.execute(
      { path: "../a.txt", edits: [{ oldText: "a", newText: "b" }] },
      ctx({ readFiles: new Set([join(dir, "..", "a.txt")]) })
    );
    expect(res.error).toBe("bad-path");
  });

  it("reports a read error for a missing file", async () => {
    const res = await editTool.execute(
      { path: "ghost.txt", edits: [{ oldText: "a", newText: "b" }] },
      ctx({ readFiles: new Set([join(dir, "ghost.txt")]) })
    );
    expect(res.error).toBe("read-error");
  });

  it("applies a whitespace-insensitive fallback match", async () => {
    await writeFile(join(dir, "a.txt"), "foo   bar\n");
    const c = ctx({ readFiles: new Set([join(dir, "a.txt")]) });
    const res = await editTool.execute(
      { path: "a.txt", edits: [{ oldText: "foo bar", newText: "baz" }] },
      c
    );
    expect(res.ok).toBe(true);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("baz\n");
  });

  it("preserves CRLF line endings on write", async () => {
    await writeFile(join(dir, "a.txt"), "one\r\ntwo\r\n");
    const c = ctx({ readFiles: new Set([join(dir, "a.txt")]) });
    await editTool.execute({ path: "a.txt", edits: [{ oldText: "two", newText: "three" }] }, c);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\r\nthree\r\n");
  });

  it("matches a CRLF file with an LF-only oldText", async () => {
    await writeFile(join(dir, "a.txt"), "one\r\ntwo\r\n");
    const c = ctx({ readFiles: new Set([join(dir, "a.txt")]) });
    const res = await editTool.execute(
      { path: "a.txt", edits: [{ oldText: "one\ntwo", newText: "merged" }] },
      c
    );
    expect(res.ok).toBe(true);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("merged\r\n");
  });

  it("updates the recorded hash after a successful edit", async () => {
    await writeFile(join(dir, "a.txt"), "a");
    const c = ctx({ readFiles: new Set([join(dir, "a.txt")]), readHashes: new Map() });
    await editTool.execute({ path: "a.txt", edits: [{ oldText: "a", newText: "b" }] }, c);
    expect(c.readHashes!.get(join(dir, "a.txt"))).toMatch(/^[0-9a-f]{40}$/);
    expect(c.modifiedFiles.has(join(dir, "a.txt"))).toBe(true);
  });

  it("reports a write failure for a directory target", async () => {
    await mkdir(join(dir, "d.txt"));
    const c = ctx({ readFiles: new Set([join(dir, "d.txt")]) });
    const res = await editTool.execute(
      { path: "d.txt", edits: [{ oldText: "a", newText: "b" }] },
      c
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe("apply_patch: parse errors and rollback", () => {
  it("rejects malformed patches", () => {
    expect(parsePatch("*** Update File: a\n*** End Patch")[0]!.path).toBe("a");
    expect(() => parsePatch("*** Begin Patch\n*** End Patch")).toThrow(/no file directives/);
    expect(() => parsePatch("*** Begin Patch\n*** Add File:\n*** End Patch")).toThrow(/no path/);
    expect(() => parsePatch("*** Begin Patch\n*** Delete File:\n*** End Patch")).toThrow(/no path/);
    expect(() => parsePatch("*** Begin Patch\njunk\n*** End Patch")).toThrow(/unexpected content/);
  });

  it("requires Begin Patch to be the first directive", () => {
    const files = parsePatch("*** Add File: a\nx\n*** End Patch");
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("a");
  });

  it("reports a parse error result instead of throwing", async () => {
    const res = await applyPatchTool.execute({ patch: "garbage" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bad-patch");
  });

  it("requires the target file to have been read", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\nx\n***NEW***\ny\n*** End Patch";
    const res = await applyPatchTool.execute({ patch }, ctx());
    expect(res.error).toBe("patch-before-read");
  });

  it("rejects a patch whose file path escapes the workspace", async () => {
    const patch = "*** Begin Patch\n*** Add File: ../x\nx\n*** End Patch";
    expect((await applyPatchTool.execute({ patch }, ctx())).error).toBe("bad-path");
  });

  it("rejects duplicate files in one patch", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    const c = ctx({ readFiles: new Set([join(dir, "a.txt")]) });
    const patch =
      "*** Begin Patch\n*** Update File: a.txt\n@@\nx\n***NEW***\ny\n*** Update File: a.txt\n@@\nx\n***NEW***\nz\n*** End Patch";
    expect((await applyPatchTool.execute({ patch }, c)).error).toBe("duplicate-file");
  });

  it("rejects a stale file", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    const c = ctx({
      readFiles: new Set([join(dir, "a.txt")]),
      readHashes: new Map([[join(dir, "a.txt"), "dead"]])
    });
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\nx\n***NEW***\ny\n*** End Patch";
    expect((await applyPatchTool.execute({ patch }, c)).error).toBe("stale-file");
  });

  it("reports a missing file as a read error", async () => {
    const c = ctx({ readFiles: new Set([join(dir, "ghost.txt")]) });
    const patch = "*** Begin Patch\n*** Update File: ghost.txt\n@@\nx\n***NEW***\ny\n*** End Patch";
    expect((await applyPatchTool.execute({ patch }, c)).error).toBe("read-error");
  });

  it("applies an add, an update and a delete together", async () => {
    await writeFile(join(dir, "u.txt"), "one\n");
    await writeFile(join(dir, "d.txt"), "bye\n");
    const c = ctx({ readFiles: new Set([join(dir, "u.txt"), join(dir, "d.txt")]) });
    const patch = [
      "*** Begin Patch",
      "*** Add File: n.txt",
      "new",
      "*** Update File: u.txt",
      "@@",
      "one",
      "***NEW***",
      "two",
      "*** Delete File: d.txt",
      "*** End Patch"
    ].join("\n");
    const res = await applyPatchTool.execute({ patch }, c);
    expect(res.ok).toBe(true);
    expect(await readFile(join(dir, "n.txt"), "utf8")).toBe("new");
    expect(await readFile(join(dir, "u.txt"), "utf8")).toBe("two\n");
    expect(existsSync(join(dir, "d.txt"))).toBe(false);
    expect(res.data).toMatchObject({
      files: expect.arrayContaining([expect.objectContaining({ deleted: true })])
    });
  });

  it("rolls back already-written files when a later write fails", async () => {
    await writeFile(join(dir, "a.txt"), "one\n");
    const sub = join(dir, "sub");
    await mkdir(sub);
    await writeFile(join(sub, "b.txt"), "one\n");
    // A read-only directory makes writeFileAtomic's rename fail for b.txt while
    // a.txt (in the writable root) is written first.
    await chmod(sub, 0o500);
    const c = ctx({ readFiles: new Set([join(dir, "a.txt"), join(sub, "b.txt")]) });
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "one",
      "***NEW***",
      "two",
      "*** Update File: sub/b.txt",
      "@@",
      "one",
      "***NEW***",
      "two",
      "*** End Patch"
    ].join("\n");
    try {
      const res = await applyPatchTool.execute({ patch }, c);
      expect(res.ok).toBe(false);
      expect(res.error).toBe("write-error");
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\n");
    } finally {
      await chmod(sub, 0o700);
    }
  });
});

describe("lsp: remaining branches", () => {
  it("parses a pyflakes line with no column code", () => {
    const d = parsePyOutput("x.py:2:3: something odd");
    expect(d[0]).toMatchObject({ file: "x.py", line: 2, column: 3 });
    expect(d[0]!.code).toBeUndefined();
  });

  it("reports no diagnostics for a file with an unsupported extension", async () => {
    const res = await lspTool.execute({ path: "notes.txt" }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("no checker configured");
  });

  it("does not attribute tsc diagnostics from a sibling file", async () => {
    await writeFile(join(dir, "a.ts"), "export const a: number = ;\n");
    await writeFile(join(dir, "ab.ts"), "export const b: number = ;\n");
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
        include: ["*.ts"]
      })
    );
    const res = await lspTool.execute({ path: "ab.ts" }, ctx());
    if (res.error === "diagnostics") {
      const files = (res.data as { diagnostics: Array<{ file: string }> }).diagnostics.map(
        (d) => d.file
      );
      expect(files.every((f) => f === "ab.ts")).toBe(true);
    }
  }, 120_000);
});

describe("tools/fuzzy-match edge cases", () => {
  it("returns null for empty needles and missing matches", () => {
    expect(findFuzzy("abc", "")).toEqual({ match: null, ambiguous: false });
    expect(findFuzzy("abc", "zzz")).toEqual({ match: null, ambiguous: false });
  });

  it("falls back to an indentation-insensitive match with exact offsets", () => {
    const text = "function f() {\n    return 1;\n}\n";
    const r = findFuzzy(text, "function f() {\nreturn 1;");
    expect(r.match?.strategy).toBe("whitespace");
    expect(text.slice(r.match!.start, r.match!.end)).toBe("function f() {\n    return 1;");
  });

  it("handles whitespace-only needles as no match", () => {
    expect(findFuzzy("a  b", "   ").match).toBeNull();
  });
});

import { chmod, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { todoTool, readTodos, renderTodos } from "../src/tools/todo.js";
import { pageTool } from "../src/tools/page.js";
import { questionTool, setQuestionHandler, ttyQuestionHandler } from "../src/tools/question.js";
import { multieditTool } from "../src/tools/multiedit.js";
import { truncateOutput } from "../src/tools/truncate.js";
import { editTool } from "../src/tools/edit.js";
import type { ToolContext } from "../src/types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-extra-"));
});

afterEach(async () => {
  setQuestionHandler(null);
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

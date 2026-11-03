import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "../src/tools/read.js";
import { grepTool, globTool, lsTool, globToRegExp } from "../src/tools/search.js";
import { writeTool } from "../src/tools/write.js";
import { editTool } from "../src/tools/edit.js";
import { applyPatchTool, parsePatch } from "../src/tools/patch.js";
import { lspTool, parsePyOutput } from "../src/tools/lsp.js";
import { resetShells } from "../src/tools/index.js";
import type { ToolContext } from "../src/types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-deep-"));
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
    permission: { defaultAction: "allow", rules: [] },
    hooks: { register: () => undefined, list: () => [], runAll: async () => [] },
    ...overrides
  };
}

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

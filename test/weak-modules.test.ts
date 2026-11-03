import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { lspTool, parsePyOutput, parseTscOutput } from "../src/tools/lsp.js";
import { fetchTool } from "../src/tools/fetch.js";
import { loadMemory } from "../src/context/memory.js";
import { collectText } from "../src/util/stream.js";
import { Hooks } from "../src/tools/hooks.js";
import type { ToolContext } from "../src/types.js";
import type { PermissionPolicy } from "../src/tools/permissions.js";

let dir = "";
let server: Server | null = null;
let base = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-weak-"));
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
  await rm(dir, { recursive: true, force: true });
});

function perm(overrides: Partial<PermissionPolicy> = {}): PermissionPolicy {
  return {
    defaultAction: "allow",
    rules: [],
    networkEnabled: true,
    networkAllowlist: ["127.0.0.1"],
    ...overrides
  };
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: dir,
    readFiles: new Set(),
    readHashes: new Map(),
    modifiedFiles: new Set(),
    maxOutputBytes: 32 * 1024,
    permission: perm(),
    hooks: { register: () => undefined, list: () => [], runAll: async () => [] },
    ...overrides
  };
}

async function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/text")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello body");
      return;
    }
    if (url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"a":1}');
      return;
    }
    if (url === "/missing") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
      return;
    }
    if (url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    }
    if (url === "/bad-redirect") {
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
      return;
    }
    if (url === "/invalid-redirect") {
      res.writeHead(302, { location: "http://[::1" });
      res.end();
      return;
    }
    if (url === "/large") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(4096, 0x61));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("root");
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server!.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
}

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

describe("memory: hierarchical and glob loading", () => {
  it("loads nested memory files in ancestor order with source comments", async () => {
    const root = join(dir, "proj");
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "top level\n");
    await writeFile(join(root, "sub", "CONTEXT.md"), "nested\n");
    const bundle = await loadMemory(join(root, "sub"));
    expect(bundle.files.map((f) => f.path)).toEqual([
      join(root, "AGENTS.md"),
      join(root, "sub", "CONTEXT.md")
    ]);
    expect(bundle.text).toContain("<!-- ../AGENTS.md -->");
    expect(bundle.text).toContain("<!-- CONTEXT.md -->");
    expect(bundle.text).toContain("nested");
  });

  it("skips empty memory files", async () => {
    await writeFile(join(dir, "AGENTS.md"), "   \n\n");
    expect((await loadMemory(dir)).files).toEqual([]);
  });

  it("expands instruction globs, dedupes and sorts them", async () => {
    const docs = join(dir, "docs");
    await mkdir(docs);
    await writeFile(join(docs, "b.md"), "bee\n");
    await writeFile(join(docs, "a.md"), "ay\n");
    const bundle = await loadMemory(dir, ["docs/*.md"]);
    expect(bundle.files.map((f) => f.path)).toEqual([join(docs, "a.md"), join(docs, "b.md")]);
  });

  it("accepts a glob with no wildcard and an absolute glob", async () => {
    await mkdir(join(dir, "docs"));
    await writeFile(join(dir, "docs", "one.md"), "1\n");
    expect((await loadMemory(dir, ["docs/one.md"])).files).toHaveLength(1);
    expect((await loadMemory(dir, [join(dir, "docs", "*.md")])).files).toHaveLength(1);
  });

  it("dedupes a glob hit that duplicates a hierarchical memory file", async () => {
    await writeFile(join(dir, "AGENTS.md"), "a\n");
    const bundle = await loadMemory(dir, ["AGENTS.md"]);
    expect(bundle.files).toHaveLength(1);
  });

  it("ignores unmatched and nonexistent globs", async () => {
    expect((await loadMemory(dir, ["nope/*.md"])).files).toEqual([]);
  });
});

describe("fetch tool", () => {
  it("rejects an invalid url and a non-http protocol", async () => {
    expect((await fetchTool.execute({ url: "::bad" }, ctx())).error).toBe("bad-url");
    expect((await fetchTool.execute({ url: "ftp://x/y" }, ctx())).error).toBe("bad-protocol");
  });

  it("denies hosts outside the allowlist", async () => {
    const res = await fetchTool.execute({ url: "https://evil.test/" }, ctx());
    expect(res.error).toBe("network-denied");
  });

  it("honours a deny decision from the permission policy", async () => {
    await startServer();
    const res = await fetchTool.execute(
      { url: `${base}/text` },
      ctx({ permission: perm({ rules: [{ tool: "fetch", action: "deny" }] }) })
    );
    expect(res.error).toBe("permission-denied");
  });

  it("returns the body and metadata for a 200", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/text` }, ctx());
    expect(res.ok).toBe(true);
    expect(res.content).toBe("hello body");
    expect(res.data).toMatchObject({ status: 200, bytes: 10, truncated: false });
  });

  it("reports a non-2xx status while still returning the body", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/missing` }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("http 404");
    expect(res.content).toBe("nope");
  });

  it("caps the body and flags over-read", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/large`, maxBytes: 100 }, ctx());
    expect(res.ok).toBe(true);
    const data = res.data as { bytes: number; bodyCapped: boolean };
    expect(data.bytes).toBe(100);
    expect(data.bodyCapped).toBe(true);
  });

  it("clamps maxBytes into the supported range", async () => {
    await startServer();
    const low = await fetchTool.execute({ url: `${base}/text`, maxBytes: -10 }, ctx());
    expect(low.ok).toBe(true);
    const huge = await fetchTool.execute({ url: `${base}/text`, maxBytes: 1e12 }, ctx());
    expect(huge.ok).toBe(true);
    const nan = await fetchTool.execute({ url: `${base}/text`, maxBytes: "x" }, ctx());
    expect(nan.ok).toBe(true);
  });

  it("refuses a redirect to a non-allowlisted host", async () => {
    await startServer();
    const res = await fetchTool.execute(
      { url: `${base}/loop` },
      ctx({ permission: perm({ networkAllowlist: ["localhost"] }) })
    );
    // The target is 127.0.0.1, not localhost, so the first hop is denied.
    expect(res.error).toBe("network-denied");
  });

  it("stops after too many redirects", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/loop` }, ctx());
    expect(res.error).toBe("too-many-redirects");
  });

  it("rejects a redirect to a non-http scheme", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/bad-redirect` }, ctx());
    expect(res.error).toBe("bad-redirect");
  });

  it("rejects an unparsable redirect location", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/invalid-redirect` }, ctx());
    expect(res.ok).toBe(false);
  });

  it("maps a network error to a failed result", async () => {
    const res = await fetchTool.execute({ url: "http://127.0.0.1:1/x" }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("fetch failed");
  });
});

describe("collectText", () => {
  it("collects a streamed body and flushes a trailing partial sequence", async () => {
    const chunks = [Buffer.from("ab"), Buffer.from([0xe4, 0xb8])];
    const sink = collectText(Readable.from(chunks));
    await new Promise((r) => setTimeout(r, 10));
    // A dangling partial multi-byte tail is dropped, not emitted as U+FFFD.
    expect(sink.flush()).toBe("ab");
    expect(sink.capped).toBe(false);
  });

  it("caps output at the byte budget and stops counting", async () => {
    const sink = collectText(Readable.from([Buffer.from("abcdef"), Buffer.from("ghij")]), {
      cap: 4
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.capped).toBe(true);
    expect(sink.text).toBe("abcd");
    expect(sink.flush()).toBe("abcd");
  });

  it("accepts string chunks", async () => {
    const sink = collectText(Readable.from(["hello"]));
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.flush()).toBe("hello");
  });
});

describe("hooks", () => {
  it("runs every registered hook and reports pass/fail", async () => {
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 });
    hooks.register({ name: "ok", command: "echo fine" });
    hooks.register({ name: "bad", command: "echo boom >&2; exit 2" });
    const results = await hooks.runAll();
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["ok", true],
      ["bad", false]
    ]);
    expect(results[1]!.output).toContain("boom");
  });

  it("times out a hook and reports timedOut", async () => {
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 });
    hooks.register({ name: "slow", command: "sleep 30", timeoutMs: 300 });
    const [r] = await hooks.runAll();
    expect(r!.ok).toBe(false);
    expect(r!.timedOut).toBe(true);
  });

  it("caps hook output at the byte budget", async () => {
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 16 });
    hooks.register({ name: "loud", command: "echo 'abcdefghijklmnopqrstuvwxyz'" });
    const [r] = await hooks.runAll();
    expect(r!.output).toContain("[truncated]");
  });

  it("refuses to start when the signal is already aborted", async () => {
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 });
    hooks.register({ name: "x", command: "echo hi" });
    const ac = new AbortController();
    ac.abort();
    const results = await hooks.runAll(ac.signal);
    expect(results).toEqual([]);
  });

  it("reports a spawn failure as a failed hook", async () => {
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 });
    hooks.register({ name: "x", command: "exit 3" });
    const [r] = await hooks.runAll();
    expect(r!.ok).toBe(false);
  });

  it("lists a copy of registered hooks", () => {
    const hooks = new Hooks({ workspaceDir: dir, timeoutMs: 1000, maxOutputBytes: 100 });
    hooks.register({ name: "a", command: "true" });
    const list = hooks.list();
    list.push({ name: "b", command: "true" });
    expect(hooks.list()).toHaveLength(1);
  });
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

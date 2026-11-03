import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlToText, parseDuckDuckGo, webfetchTool, websearchTool } from "../src/tools/web.js";
import type { PermissionPolicy } from "../src/tools/permissions.js";
import type { ToolContext } from "../src/types.js";
import { fetchTool } from "../src/tools/fetch.js";
import { createServer, type Server } from "node:http";

let dir = "";
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-web-"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  delete process.env.MAZE_SEARCH_URL;
  await rm(dir, { recursive: true, force: true });
});

function policy(overrides: Partial<PermissionPolicy> = {}): PermissionPolicy {
  return {
    defaultAction: "allow",
    rules: [],
    networkEnabled: true,
    networkAllowlist: ["example.com"],
    ...overrides
  };
}

const perm = policy;

function ctx(p: PermissionPolicy, signal?: AbortSignal): ToolContext {
  return {
    workspaceDir: dir,
    readFiles: new Set(),
    readHashes: new Map(),
    modifiedFiles: new Set(),
    maxOutputBytes: 32 * 1024,
    permission: p,
    hooks: { register: () => undefined, list: () => [], runAll: async () => [] },
    signal
  };
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

let server: Server | null = null;
let base = "";

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

describe("htmlToText", () => {
  it("drops scripts, styles and markup and keeps block breaks", () => {
    const html =
      "<html><head><style>.a{color:red}</style><script>evil()</script></head>" +
      "<body><h1>Title</h1><p>Para <b>one</b></p><div>Two<br>Three</div><noscript>x</noscript></body></html>";
    expect(htmlToText(html)).toBe("Title\nPara one\nTwo\nThree");
  });

  it("decodes named and numeric entities", () => {
    expect(htmlToText("<p>A &amp; B &lt;c&gt; &quot;d&quot; &#39;e&#39; &nbsp;f</p>")).toBe(
      "A & B <c> \"d\" 'e' f"
    );
    expect(htmlToText("<p>&#65;&#x42;</p>")).toBe("AB");
  });

  it("collapses runs of whitespace and drops blank lines", () => {
    expect(htmlToText("<p>  a     b  </p>\n\n<p>   </p><p>c</p>")).toBe("a b\nc");
  });
});

describe("parseDuckDuckGo", () => {
  const page = `
    <a class="result__a" href="https://a.example/1">First &amp; best</a>
    <a class="result__snippet" href="https://a.example/1">Snippet <b>one</b></a>
    <a class="result__a" href="https://b.example/2">Second</a>
    <a class="result__snippet" href="https://b.example/2">Snippet two</a>
    <a class="result__a" href="https://c.example/3">Third</a>
  `;

  it("extracts titles, urls and snippets in order", () => {
    expect(parseDuckDuckGo(page, 10)).toEqual([
      {
        title: "First & best",
        url: "https://a.example/1",
        snippet: "Snippet one"
      },
      { title: "Second", url: "https://b.example/2", snippet: "Snippet two" },
      { title: "Third", url: "https://c.example/3", snippet: "" }
    ]);
  });

  it("honours the result limit", () => {
    expect(parseDuckDuckGo(page, 1)).toHaveLength(1);
    expect(parseDuckDuckGo(page, 0)).toHaveLength(0);
  });

  it("ignores anchors without a usable title", () => {
    expect(parseDuckDuckGo('<a class="result__a" href="https://x">   </a>', 5)).toEqual([]);
  });
});

describe("websearch tool", () => {
  it("rejects an empty query", async () => {
    const res = await websearchTool.execute({ query: "  " }, ctx(policy()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("empty-query");
  });

  it("denies hosts outside the network allowlist", async () => {
    process.env.MAZE_SEARCH_URL = "https://not-allowed.test/html/";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const res = await websearchTool.execute({ query: "x" }, ctx(policy()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("network-denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows an allowlisted subdomain", async () => {
    process.env.MAZE_SEARCH_URL = "https://search.example.com/html/";
    globalThis.fetch = vi.fn(async () => htmlResponse("<p>empty</p>")) as unknown as typeof fetch;
    const res = await websearchTool.execute({ query: "x" }, ctx(policy()));
    expect(res.ok).toBe(true);
    expect(res.content).toContain("no parsed results");
  });

  it("parses results and formats them", async () => {
    process.env.MAZE_SEARCH_URL = "https://example.com/html/";
    globalThis.fetch = vi.fn(async () =>
      htmlResponse(
        '<a class="result__a" href="https://a.example/1">One</a>' +
          '<a class="result__snippet">first</a>'
      )
    ) as unknown as typeof fetch;

    const res = await websearchTool.execute({ query: "hello world" }, ctx(policy()));
    expect(res.ok).toBe(true);
    expect(res.content).toContain("1. One");
    expect(res.content).toContain("https://a.example/1");
    expect(res.content).toContain("first");
    expect((res.data as { count: number }).count).toBe(1);
    const calledUrl = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock
      .calls[0]![0];
    expect(calledUrl).toContain("q=hello%20world");
  });

  it("falls back to page text when nothing parses", async () => {
    process.env.MAZE_SEARCH_URL = "https://example.com/html/";
    globalThis.fetch = vi.fn(async () =>
      htmlResponse("<p>nothing here</p>")
    ) as unknown as typeof fetch;
    const res = await websearchTool.execute({ query: "x" }, ctx(policy()));
    expect(res.ok).toBe(true);
    expect(res.content).toContain("no parsed results");
    expect(res.content).toContain("nothing here");
  });

  it("maps a non-2xx response to an error", async () => {
    process.env.MAZE_SEARCH_URL = "https://example.com/html/";
    globalThis.fetch = vi.fn(async () => htmlResponse("nope", 503)) as unknown as typeof fetch;
    const res = await websearchTool.execute({ query: "x" }, ctx(policy()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("http-503");
  });

  it("surfaces a thrown fetch as fetch-error", async () => {
    process.env.MAZE_SEARCH_URL = "https://example.com/html/";
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await websearchTool.execute({ query: "x" }, ctx(policy()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("fetch-error");
    expect(res.content).toContain("network down");
  });
});

describe("webfetch tool", () => {
  it("rejects malformed and non-http urls", async () => {
    expect((await webfetchTool.execute({ url: "not a url" }, ctx(policy()))).error).toBe("bad-url");
    expect((await webfetchTool.execute({ url: "file:///etc/passwd" }, ctx(policy()))).error).toBe(
      "bad-protocol"
    );
  });

  it("denies a host outside the allowlist", async () => {
    const res = await webfetchTool.execute({ url: "https://evil.test/x" }, ctx(policy()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("network-denied");
  });

  it("converts HTML to text by default", async () => {
    globalThis.fetch = vi.fn(async () =>
      htmlResponse("<h1>Hi</h1><p>Body &amp; more</p>")
    ) as unknown as typeof fetch;
    const res = await webfetchTool.execute({ url: "https://example.com/page" }, ctx(policy()));
    expect(res.ok).toBe(true);
    expect(res.content).toBe("Hi\nBody & more");
  });

  it("returns raw HTML when format is html", async () => {
    globalThis.fetch = vi.fn(async () => htmlResponse("<h1>Hi</h1>")) as unknown as typeof fetch;
    const res = await webfetchTool.execute(
      { url: "https://example.com/page", format: "html" },
      ctx(policy())
    );
    expect(res.content).toBe("<h1>Hi</h1>");
  });

  it("leaves non-HTML bodies untouched", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('{"a":1}', { status: 200, headers: { "content-type": "application/json" } })
    ) as unknown as typeof fetch;
    const res = await webfetchTool.execute({ url: "https://example.com/api" }, ctx(policy()));
    expect(res.content).toBe('{"a":1}');
  });

  it("reports an http error status but still returns the body", async () => {
    globalThis.fetch = vi.fn(async () =>
      htmlResponse("<p>missing</p>", 404)
    ) as unknown as typeof fetch;
    const res = await webfetchTool.execute({ url: "https://example.com/x" }, ctx(policy()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("http 404");
    expect(res.content).toBe("missing");
  });

  it("caps the downloaded body at maxBytes", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("a".repeat(500), { status: 200, headers: { "content-type": "text/plain" } })
    ) as unknown as typeof fetch;
    const res = await webfetchTool.execute(
      { url: "https://example.com/big", maxBytes: 10 },
      ctx(policy())
    );
    expect(res.content).toBe("a".repeat(10));
  });

  it("truncates the returned body at the context output budget", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("a".repeat(5000), { status: 200, headers: { "content-type": "text/plain" } })
    ) as unknown as typeof fetch;
    const c = { ...ctx(policy()), maxOutputBytes: 100 };
    const res = await webfetchTool.execute({ url: "https://example.com/big" }, c);
    expect(res.content).toContain("truncated");
    expect(Buffer.byteLength(res.content)).toBeLessThan(300);
  });

  it("surfaces a thrown fetch as fetch-error", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("dns failure");
    }) as unknown as typeof fetch;
    const res = await webfetchTool.execute({ url: "https://example.com/x" }, ctx(policy()));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("fetch-error");
  });

  it("fails closed when the permission ask handler is absent", async () => {
    const p = policy({
      networkAllowlist: ["example.com"],
      defaultAction: "ask",
      networkEnabled: true
    });
    const res = await webfetchTool.execute({ url: "https://example.com/x" }, ctx(p));
    expect(res.ok).toBe(false);
    expect(res.error).toBe("permission-denied");
  });
});

describe("fetch tool", () => {
  const fetchCtx = (overrides: Partial<PermissionPolicy> = {}): ToolContext =>
    ctx(perm({ networkAllowlist: ["127.0.0.1"], ...overrides }));

  it("rejects an invalid url and a non-http protocol", async () => {
    expect((await fetchTool.execute({ url: "::bad" }, fetchCtx())).error).toBe("bad-url");
    expect((await fetchTool.execute({ url: "ftp://x/y" }, fetchCtx())).error).toBe("bad-protocol");
  });

  it("denies hosts outside the allowlist", async () => {
    const res = await fetchTool.execute({ url: "https://evil.test/" }, fetchCtx());
    expect(res.error).toBe("network-denied");
  });

  it("honours a deny decision from the permission policy", async () => {
    await startServer();
    const res = await fetchTool.execute(
      { url: `${base}/text` },
      fetchCtx({ rules: [{ tool: "fetch", action: "deny" }] })
    );
    expect(res.error).toBe("permission-denied");
  });

  it("returns the body and metadata for a 200", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/text` }, fetchCtx());
    expect(res.ok).toBe(true);
    expect(res.content).toBe("hello body");
    expect(res.data).toMatchObject({ status: 200, bytes: 10, truncated: false });
  });

  it("reports a non-2xx status while still returning the body", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/missing` }, fetchCtx());
    expect(res.ok).toBe(false);
    expect(res.error).toBe("http 404");
    expect(res.content).toBe("nope");
  });

  it("caps the body and flags over-read", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/large`, maxBytes: 100 }, fetchCtx());
    expect(res.ok).toBe(true);
    const data = res.data as { bytes: number; bodyCapped: boolean };
    expect(data.bytes).toBe(100);
    expect(data.bodyCapped).toBe(true);
  });

  it("clamps maxBytes into the supported range", async () => {
    await startServer();
    const low = await fetchTool.execute({ url: `${base}/text`, maxBytes: -10 }, fetchCtx());
    expect(low.ok).toBe(true);
    const huge = await fetchTool.execute({ url: `${base}/text`, maxBytes: 1e12 }, fetchCtx());
    expect(huge.ok).toBe(true);
    const nan = await fetchTool.execute({ url: `${base}/text`, maxBytes: "x" }, fetchCtx());
    expect(nan.ok).toBe(true);
  });

  it("refuses a redirect to a non-allowlisted host", async () => {
    await startServer();
    const res = await fetchTool.execute(
      { url: `${base}/loop` },
      fetchCtx({ networkAllowlist: ["localhost"] })
    );
    // The target is 127.0.0.1, not localhost, so the first hop is denied.
    expect(res.error).toBe("network-denied");
  });

  it("stops after too many redirects", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/loop` }, fetchCtx());
    expect(res.error).toBe("too-many-redirects");
  });

  it("rejects a redirect to a non-http scheme", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/bad-redirect` }, fetchCtx());
    expect(res.error).toBe("bad-redirect");
  });

  it("rejects an unparsable redirect location", async () => {
    await startServer();
    const res = await fetchTool.execute({ url: `${base}/invalid-redirect` }, fetchCtx());
    expect(res.ok).toBe(false);
  });

  it("maps a network error to a failed result", async () => {
    const res = await fetchTool.execute({ url: "http://127.0.0.1:1/x" }, fetchCtx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("fetch failed");
  });
});

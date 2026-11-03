import type { ToolDefinition, ToolResult } from "../types.js";
import { decide, networkAllowed } from "./permissions.js";
import { truncateOutput } from "./truncate.js";

const TIMEOUT_MS = 30_000;

function deny(name: string, message: string, error: string): ToolResult {
  return { callId: "", name, ok: false, content: message, error };
}

export function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const withBreaks = withoutScripts
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Match each result anchor, then look for the snippet anchor that follows it
  // before the next result. A single combined regex cannot capture the snippet:
  // the lazy gap consumes the snippet tag before the optional group is tried.
  const anchorRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const anchors = [...html.matchAll(anchorRe)];
  for (let i = 0; i < anchors.length; i += 1) {
    if (results.length >= limit) break;
    const m = anchors[i]!;
    const url = decodeEntities(m[1] ?? "");
    const title = htmlToText(m[2] ?? "");
    if (!url || !title) continue;
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < anchors.length ? (anchors[i + 1]!.index ?? html.length) : html.length;
    const between = html.slice(start, end);
    const snippetMatch = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(
      between
    );
    const snippet = htmlToText(snippetMatch?.[1] ?? "");
    results.push({ title, url, snippet });
  }
  return results;
}

export const websearchTool: ToolDefinition = {
  name: "websearch",
  description:
    "Search the web and return titles, URLs and snippets. Respects the permission policy's network allowlist and approval rules.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      maxResults: { type: "number", description: "Max results (default 5)." }
    },
    required: ["query"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) return deny("websearch", "empty query", "empty-query");
    const limit = Math.min(10, Math.max(1, Number(args.maxResults ?? 5) || 5));

    const endpoint = process.env.MAZE_SEARCH_URL ?? "https://html.duckduckgo.com/html/";
    if (!networkAllowed(ctx.permission, endpoint)) {
      return deny(
        "websearch",
        `network access to ${new URL(endpoint).hostname} is not allowed by the permission policy`,
        "network-denied"
      );
    }
    const decision = await decide(ctx.permission, "websearch", args);
    if (decision.action === "deny") {
      return deny("websearch", `permission denied (${decision.reason})`, "permission-denied");
    }
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    try {
      const res = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; maze-harness)" },
        signal
      });
      if (!res.ok)
        return deny("websearch", `search failed: http ${res.status}`, `http-${res.status}`);
      const html = await res.text();
      const results = parseDuckDuckGo(html, limit);
      if (results.length === 0) {
        const text = htmlToText(html).slice(0, 4000);
        return {
          callId: "",
          name: "websearch",
          ok: true,
          content: `no parsed results; page text:\n${text}`,
          data: { query, count: 0 }
        };
      }
      const t = truncateOutput(
        results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n"),
        ctx.maxOutputBytes
      );
      return {
        callId: "",
        name: "websearch",
        ok: true,
        content: t.text,
        data: { query, count: results.length, results }
      };
    } catch (err) {
      return deny(
        "websearch",
        `search failed: ${err instanceof Error ? err.message : String(err)}`,
        "fetch-error"
      );
    }
  }
};

export const webfetchTool: ToolDefinition = {
  name: "webfetch",
  description:
    "Fetch a URL and return readable text. HTML is stripped to plain text; JSON/text is returned as-is. Respects the permission policy's network allowlist on every redirect hop.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL." },
      format: {
        type: "string",
        enum: ["text", "markdown", "html"],
        description: "Output format (default text)."
      },
      maxBytes: { type: "number", description: "Maximum bytes to return." }
    },
    required: ["url"],
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    const url = String(args.url ?? "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return deny("webfetch", `invalid url: ${url}`, "bad-url");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return deny("webfetch", `refusing non-http(s) url: ${parsed.protocol}`, "bad-protocol");
    }
    if (!networkAllowed(ctx.permission, url)) {
      return deny(
        "webfetch",
        `network access to ${parsed.hostname} is not allowed by the permission policy`,
        "network-denied"
      );
    }
    const decision = await decide(ctx.permission, "webfetch", args);
    if (decision.action === "deny") {
      return deny("webfetch", `permission denied (${decision.reason})`, "permission-denied");
    }
    const limit = Math.min(
      1024 * 1024,
      Math.max(1, Number(args.maxBytes ?? 256 * 1024) || 256 * 1024)
    );
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    try {
      const res = await fetch(url, { redirect: "follow", signal });
      const raw = (await res.text()).slice(0, limit);
      const contentType = res.headers.get("content-type") ?? "";
      const format =
        args.format === "html" ? "html" : args.format === "markdown" ? "markdown" : "text";
      let body = raw;
      if (format !== "html" && /text\/html|application\/xhtml/.test(contentType)) {
        body = htmlToText(raw);
      }
      const t = truncateOutput(body, ctx.maxOutputBytes);
      return {
        callId: "",
        name: "webfetch",
        ok: res.ok,
        content: t.text,
        error: res.ok ? undefined : `http ${res.status}`,
        data: { url, status: res.status, contentType, format }
      };
    } catch (err) {
      return deny(
        "webfetch",
        `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        "fetch-error"
      );
    }
  }
};

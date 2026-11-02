import type { ToolDefinition, ToolResult } from "../types.js";
import { decide, networkAllowed } from "./permissions.js";
import { truncateOutput } from "./truncate.js";
import { FETCH_HARD_MAX_BYTES, FETCH_MAX_BYTES } from "./limits.js";

/** Redirects are followed manually so every hop is re-validated. */
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;

function deny(message: string, error: string): ToolResult {
  return { callId: "", name: "fetch", ok: false, content: message, error };
}

/** Read at most `limit` bytes from a response body without buffering the rest. */
async function readCapped(res: Response, limit: number): Promise<{ buf: Buffer; over: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf: buf.subarray(0, limit), over: buf.length > limit };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let over = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const room = limit - total;
    if (value.length > room) {
      if (room > 0) {
        chunks.push(Buffer.from(value.subarray(0, room)));
        total += room;
      }
      over = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(Buffer.from(value));
    total += value.length;
  }
  return { buf: Buffer.concat(chunks), over };
}

/**
 * HTTP GET tool.
 *
 * Exists mainly so the permission policy's network allowlist is actually
 * enforced: `networkAllowed` was previously exported but wired to nothing, so
 * the "network allowlist" in the policy was inert and `curl` via bash was the
 * only network path (controlled only by a deny-list substring).
 *
 * Redirects are followed manually (`redirect: "manual"`). The default policy
 * follows them, which let a permitted host 302 to `127.0.0.1` or a metadata
 * endpoint and return the body without any further allowlist check.
 */
export const fetchTool: ToolDefinition = {
  name: "fetch",
  description:
    "Fetch a URL with HTTP GET and return its body as text (truncated). Respects the permission policy's network allowlist and approval rules, including on every redirect hop.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL." },
      maxBytes: { type: "number", description: "Maximum bytes of the body to return." }
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
      return deny(`invalid url: ${url}`, "bad-url");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return deny(`refusing non-http(s) url: ${parsed.protocol}`, "bad-protocol");
    }
    if (!networkAllowed(ctx.permission, url)) {
      return deny(
        `network access to ${parsed.hostname} is not allowed by the permission policy`,
        "network-denied"
      );
    }
    const decision = await decide(ctx.permission, "fetch", args);
    if (decision.action === "deny") {
      return deny(`permission denied (${decision.reason})`, "permission-denied");
    }
    const limit = Math.min(
      FETCH_MAX_BYTES,
      FETCH_HARD_MAX_BYTES,
      Math.max(1, Number(args.maxBytes ?? FETCH_MAX_BYTES) || FETCH_MAX_BYTES)
    );
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    try {
      let current = url;
      let res: Response | null = null;
      for (let hop = 0; ; hop += 1) {
        res = await fetch(current, { method: "GET", redirect: "manual", signal });
        const location = res.headers.get("location");
        if (res.status < 300 || res.status >= 400 || !location) break;
        // Drain the redirect body so the socket is released.
        await res.arrayBuffer().catch(() => undefined);
        if (hop >= MAX_REDIRECTS) {
          return deny(`too many redirects (>${MAX_REDIRECTS})`, "too-many-redirects");
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return deny(`invalid redirect location: ${location}`, "bad-redirect");
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return deny(`redirect to non-http(s) url: ${next.protocol}`, "bad-redirect");
        }
        if (!networkAllowed(ctx.permission, next.toString())) {
          return deny(
            `redirect to ${next.hostname} is not allowed by the permission policy`,
            "network-denied"
          );
        }
        current = next.toString();
      }
      if (!res) return deny("fetch produced no response", "no-response");
      const { buf, over } = await readCapped(res, limit);
      // Route through the shared truncator so a truncated body carries a page
      // token the model can redeem with the `page` tool.
      const t = truncateOutput(buf.toString("utf8"), limit, "head");
      return {
        callId: "",
        name: "fetch",
        ok: res.ok,
        content: t.text,
        truncated: t.truncated
          ? { keptBytes: t.keptBytes, droppedBytes: t.droppedBytes, pageToken: t.pageToken }
          : undefined,
        error: res.ok ? undefined : `http ${res.status}`,
        data: {
          url,
          finalUrl: current,
          status: res.status,
          bytes: buf.length,
          truncated: t.truncated,
          bodyCapped: over
        }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return deny(`fetch failed: ${message}`, message);
    }
  }
};

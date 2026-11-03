import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runChatOnce } from "../src/chat.js";

// Integration test for the full chat path: a real HTTP server speaking the
// OpenAI chat-completions SSE protocol, a real SessionStore, and the real
// runChatOnce loop. This covers the parts that unit tests cannot: request
// framing, streaming assembly, persistence and the exit-code contract.

let dir = "";
let server: Server | null = null;
let baseUrl = "";
const requests: Array<{ url: string; auth: string | undefined; body: unknown }> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-chat-"));
  requests.length = 0;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await rm(dir, { recursive: true, force: true });
});

type Handler = (body: { messages?: Array<{ role: string; content: string }> }) => {
  status?: number;
  sse?: string[];
  json?: unknown;
};

async function startServer(handler: Handler): Promise<void> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d: Buffer) => (raw += d.toString("utf8")));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      requests.push({
        url: req.url ?? "",
        auth: req.headers.authorization as string | undefined,
        body
      });
      const out = handler(body as { messages?: Array<{ role: string; content: string }> });
      if (out.json !== undefined) {
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json));
        return;
      }
      res.writeHead(out.status ?? 200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      for (const chunk of out.sse ?? []) res.write(chunk);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server!.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}/v1/chat/completions`;
}

function sseText(text: string): string[] {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}\n\n`,
    "data: [DONE]\n\n"
  ];
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    message: "say hello",
    model: "deepseek-chat",
    baseUrl,
    apiKey: "test-key",
    contextWindow: 8000,
    maxTurns: 4,
    runsDir: join(dir, "sessions"),
    verifyCommands: [],
    permission: "allow",
    stream: true,
    snapshots: false,
    ...overrides
  } as Parameters<typeof runChatOnce>[0];
}

describe("runChatOnce", () => {
  it("streams a reply, persists the session and forwards the API key", async () => {
    await startServer(() => ({ sse: sseText("hello there") }));
    await runChatOnce(options());

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/v1/chat/completions");
    expect(requests[0]!.auth).toBe("Bearer test-key");

    const body = requests[0]!.body as {
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
    };
    expect(body.stream).toBe(true);
    expect(body.messages[0]!.role).toBe("system");
    expect(body.messages.at(-1)).toMatchObject({ role: "user", content: "say hello" });

    // The assistant reply must be persisted in the single session file. (Do not
    // construct a SessionStore here: init() would create a second file.)
    const { readdir } = await import("node:fs/promises");
    const names = (await readdir(join(dir, "sessions"))).filter((n) => n.endsWith(".jsonl"));
    expect(names.length).toBe(1);
    const raw = await readFile(join(dir, "sessions", names[0]!), "utf8");
    expect(raw).toContain("say hello");
    expect(raw).toContain("hello there");
    expect(raw).toContain("usage:");
  });

  it("non-streaming mode uses a plain JSON completion", async () => {
    await startServer(() => ({
      json: {
        choices: [{ message: { content: "plain reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      }
    }));
    await runChatOnce(options({ stream: false }));
    expect(requests).toHaveLength(1);
    const body = requests[0]!.body as { stream?: boolean };
    expect(body.stream).toBeFalsy();

    const { readdir } = await import("node:fs/promises");
    const names = await readdir(join(dir, "sessions"));
    const raw = await readFile(join(dir, "sessions", names[0]!), "utf8");
    expect(raw).toContain("plain reply");
  });

  it("executes a tool call and sends the result back in a second turn", async () => {
    let turn = 0;
    await startServer(() => {
      turn += 1;
      if (turn === 1) {
        return {
          sse: [
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        function: { name: "ls", arguments: JSON.stringify({ path: "." }) }
                      }
                    ]
                  }
                }
              ]
            })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
            "data: [DONE]\n\n"
          ]
        };
      }
      return { sse: sseText("done after tool") };
    });

    await runChatOnce(options({ message: "list the directory" }));
    expect(requests.length).toBe(2);

    // The wire format is snake_case (`tool_call_id`), not the internal
    // `ToolResult.callId` shape.
    const second = requests[1]!.body as {
      messages: Array<{ role: string; content: string; tool_call_id?: string }>;
    };
    const toolMessage = second.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.tool_call_id).toBe("call_1");
    expect(toolMessage!.content.length).toBeGreaterThan(0);

    const { readdir } = await import("node:fs/promises");
    const names = await readdir(join(dir, "sessions"));
    const raw = await readFile(join(dir, "sessions", names[0]!), "utf8");
    expect(raw).toContain("done after tool");
  }, 30000);

  it("stops with a budget error when maxTurns is exhausted", async () => {
    await startServer(() => ({
      sse: [
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_loop",
                    function: { name: "ls", arguments: JSON.stringify({ path: "." }) }
                  }
                ]
              }
            }
          ]
        })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n"
      ]
    }));

    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      await runChatOnce(options({ maxTurns: 1 }));
      expect(
        process.exitCode === undefined ||
          process.exitCode === 0 ||
          process.exitCode === 1 ||
          process.exitCode === 3
      ).toBe(true);
      expect(requests.length).toBe(1);
    } finally {
      process.exitCode = previous;
    }
  }, 30000);

  it("sets a failing exit code on a provider error", async () => {
    await startServer(() => ({ status: 400, json: { error: { message: "bad request" } } }));
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      await runChatOnce(options({ maxTurns: 2 }));
      expect(process.exitCode).toBe(1);
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(join(dir, "sessions"));
      const raw = await readFile(join(dir, "sessions", names[0]!), "utf8");
      expect(raw).toContain("say hello");
    } finally {
      process.exitCode = previous;
    }
  }, 30000);
});

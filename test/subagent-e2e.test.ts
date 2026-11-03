import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSubAgent, subAgentTool, findSubAgent } from "../src/subagents.js";

let dir = "";
let server: Server | null = null;
let base = "";
let lastBody: Record<string, unknown> | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-subagent-"));
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastBody = JSON.parse(raw || "{}") as Record<string, unknown>;
      if (lastBody.stream) {
        // The sub-agent always streams; answer with SSE frames.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          [
            'data: {"choices":[{"delta":{"content":"sub-agent final answer"}}]}\n\n',
            'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n',
            "data: [DONE]\n\n"
          ].join("")
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "sub-agent final answer" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
        })
      );
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server!.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("runSubAgent", () => {
  it("runs a sub-agent end to end and writes a transcript", async () => {
    const spec = findSubAgent("explore")!;
    const result = await runSubAgent({
      spec,
      task: "map the codebase",
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: base,
      apiKey: "k",
      sessionsDir: join(dir, "sessions")
    });
    expect(result.text).toBe("sub-agent final answer");
    expect(result.stopReason).toBe("done");
    expect(result.turns).toBeGreaterThan(0);
    expect(result.tokens.totalTokens).toBe(16);
    const raw = await readFile(result.transcriptPath, "utf8");
    expect(raw).toContain("sub-agent final answer");
    // The read-only spec restricts the advertised tools.
    const body = lastBody as { messages?: Array<{ content?: string }> };
    expect(body.messages!.some((m) => String(m.content).includes("explorer"))).toBe(true);
  }, 60_000);

  it("honours a per-spec model override", async () => {
    const spec = { ...findSubAgent("plan")!, model: "gpt-4o-mini" };
    await runSubAgent({
      spec,
      task: "plan it",
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: base,
      apiKey: "k",
      sessionsDir: join(dir, "sessions")
    });
    expect((lastBody as { model?: string }).model).toBe("gpt-4o-mini");
  }, 60_000);

  it("threads the abort signal through the loop", async () => {
    const ac = new AbortController();
    ac.abort();
    const spec = findSubAgent("explore")!;
    const result = await runSubAgent({
      spec,
      task: "x",
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: base,
      apiKey: "k",
      sessionsDir: join(dir, "sessions"),
      signal: ac.signal
    });
    expect(result.stopReason).toBe("aborted");
    expect(result.text).toBe("(sub-agent produced no final answer)");
  }, 60_000);

  it("forwards loop events to the caller", async () => {
    const events: string[] = [];
    await runSubAgent({
      spec: findSubAgent("explore")!,
      task: "x",
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: base,
      apiKey: "k",
      sessionsDir: join(dir, "sessions"),
      onEvent: (e) => events.push(e.type)
    });
    expect(events).toContain("done");
    expect(events).toContain("usage");
  }, 60_000);
});

describe("delegate tool", () => {
  it("runs the named sub-agent and reports tokens", async () => {
    const tool = subAgentTool({
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: base,
      apiKey: "k",
      sessionsDir: join(dir, "sessions")
    });
    const res = await tool.execute({ agent: "explore", task: "look" }, {} as never);
    expect(res.ok).toBe(true);
    expect(res.content).toContain("[explore] sub-agent final answer");
    expect(res.content).toContain("tokens=16");
    expect((res.data as { tokens: { totalTokens: number } }).tokens.totalTokens).toBe(16);
  }, 60_000);

  it("accepts a prefix agent name and reports a provider failure", async () => {
    const tool = subAgentTool({
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k",
      sessionsDir: join(dir, "sessions"),
      // One attempt, no backoff: the port is closed so this fails immediately.
      retries: 1,
      retryBaseMs: 1
    });
    const res = await tool.execute({ agent: "expl", task: "look" }, {} as never);
    // The provider is unreachable, so the loop stops with an error, not a throw.
    expect(res.ok).toBe(false);
    expect(res.content).toContain("stop=error");
  }, 15_000);

  it("includes custom subagent definitions in the tool contract", () => {
    const tool = subAgentTool({
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: base,
      apiKey: "k",
      agents: [
        {
          name: "custom",
          description: "does custom things",
          prompt: "p",
          mode: "subagent",
          source: "file"
        } as never
      ]
    });
    expect(tool.description).toContain("custom (does custom things)");
  });
});

describe("subagent helpers", () => {
  it("finds a subagent by exact name, prefix, or not at all", async () => {
    const { findSubAgent, SUBAGENTS, specFromDefinition } = await import("../src/subagents.js");
    expect(findSubAgent("explore")!.name).toBe("explore");
    expect(findSubAgent("  EXPLORE ")!.name).toBe("explore");
    expect(findSubAgent("expl")!.name).toBe("explore");
    expect(findSubAgent("")).toBeNull();
    expect(findSubAgent("zzz")).toBeNull();
    expect(SUBAGENTS.some((s) => s.name === "verify")).toBe(true);
    const spec = specFromDefinition({
      name: "custom",
      description: "d",
      prompt: "p",
      mode: "subagent",
      source: "file",
      tools: ["read"],
      maxTurns: 3,
      model: "m",
      readOnly: true
    } as never);
    expect(spec).toMatchObject({ name: "custom", maxTurns: 3, readOnly: true });
  });

  it("delegate rejects unknown agents and empty tasks", async () => {
    const { subAgentTool } = await import("../src/subagents.js");
    const tool = subAgentTool({
      workspaceDir: dir,
      model: "deepseek-chat",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "k"
    });
    expect((await tool.execute({ agent: "nope", task: "x" }, {} as never)).error).toBe(
      "unknown-subagent"
    );
    expect((await tool.execute({ agent: "explore", task: "  " }, {} as never)).error).toBe(
      "no-task"
    );
    expect(tool.description).toContain("explore");
  });
});

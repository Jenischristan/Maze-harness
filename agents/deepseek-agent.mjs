#!/usr/bin/env node
// @ts-check
// maze-harness discovery agent backed by deepseek-router (OpenAI-compatible).
// Prompt on stdin. The model calls file/bash tools until it stops calling tools.
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { exec } from "node:child_process";

const ROUTER = process.env.DEEPSEEK_ROUTER_URL ?? "http://127.0.0.1:8788/v1/chat/completions";
const MODEL = process.env.DREAM_AGENT_MODEL ?? "deepseek-chat";
const MAX_TURNS = Number(process.env.DREAM_AGENT_MAX_TURNS ?? 12);
const KEY = process.env.DEEPSEEK_ROUTER_KEY ?? "";
const WORKDIR = process.cwd();

const SYSTEM = [
  "You are a coding agent inside a disposable git worktree.",
  "Use the provided tools to inspect and modify files in the current directory.",
  "Do not touch anything outside this directory and never run or modify an evaluator.",
  "When the task is complete, reply with a short summary and no tool calls."
].join(" ");

const TOOLS = [
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 file relative to the workspace.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a UTF-8 file relative to the workspace.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "list_dir", description: "List entries of a directory relative to the workspace.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "bash", description: "Run a shell command in the workspace root.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }
];

function inside(p) {
  const full = resolve(WORKDIR, p ?? ".");
  const root = resolve(WORKDIR) + sep;
  if (full !== resolve(WORKDIR) && !full.startsWith(root)) throw new Error(`path escapes workspace: ${p}`);
  return full;
}

function runBash(command) {
  return new Promise((done) => {
    exec(command, { cwd: WORKDIR, timeout: 120000, maxBuffer: 1 << 22 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`.slice(0, 8000);
      done(out.length > 0 ? out : `(exit ${err ? err.code ?? 1 : 0})`);
    });
  });
}

async function runTool(name, args) {
  try {
    if (name === "read_file") return await readFile(inside(args.path), "utf8");
    if (name === "write_file") {
      const full = inside(args.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, args.content ?? "", "utf8");
      return `wrote ${args.path}`;
    }
    if (name === "list_dir") return (await readdir(inside(args.path ?? "."))).sort().join("\n");
    if (name === "bash") return await runBash(args.command ?? "");
    return `unknown tool ${name}`;
  } catch (err) {
    return `tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const RETRIES = Number(process.env.DREAM_AGENT_RETRIES ?? 8);
const RETRY_BASE_MS = Number(process.env.DREAM_AGENT_RETRY_BASE_MS ?? 1500);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function jitter(ms) {
  return Math.round(ms * (0.7 + Math.random() * 0.6));
}

async function chat(messages) {
  const headers = { "content-type": "application/json" };
  if (KEY) headers.authorization = `Bearer ${KEY}`;
  const body = JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.2 });
  let lastError = "";
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    let res;
    try {
      res = await fetch(ROUTER, { method: "POST", headers, body });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(jitter(RETRY_BASE_MS * 2 ** attempt));
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text();
    lastError = `router ${res.status}: ${text}`;
    const retryable =
      res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504 ||
      /rate_limit|too frequent|INVALID_POW_RESPONSE|session/i.test(text);
    if (!retryable) throw new Error(lastError);
    await sleep(jitter(RETRY_BASE_MS * 2 ** attempt));
  }
  throw new Error(`router retries exhausted (${RETRIES}): ${lastError}`);
}

async function main() {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: prompt }
  ];
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const data = await chat(messages);
    const choice = data.choices?.[0];
    const msg = choice?.message ?? {};
    if (choice?.finish_reason !== "tool_calls" || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      process.stdout.write(`${msg.content ?? ""}\n`);
      return;
    }
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments ?? "{}");
      } catch {
        args = {};
      }
      const result = await runTool(call.function?.name, args);
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }
  process.stdout.write(`agent stopped after ${MAX_TURNS} tool turns\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

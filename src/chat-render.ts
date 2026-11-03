import type { AgentEvent } from "./agent/loop.js";
import type { ChatStreamEvent } from "./types.js";

let streaming = false;

export function printStreamEvent(event: ChatStreamEvent): void {
  switch (event.type) {
    case "text":
      if (!streaming) {
        process.stdout.write("\n◆ ");
        streaming = true;
      }
      process.stdout.write(event.delta);
      break;
    case "reasoning":
      if (process.env.MAZE_SHOW_REASONING === "1") {
        process.stderr.write(`\x1b[2m${event.delta}\x1b[0m`);
      }
      break;
    case "tool_start":
      finishStreamLine();
      break;
    case "stop":
      finishStreamLine();
      break;
    default:
      break;
  }
}

export function finishStreamLine(): void {
  if (streaming) {
    process.stdout.write("\n");
    streaming = false;
  }
}

export function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "assistant":
      if (streaming) {
        finishStreamLine();
        break;
      }
      if (event.content.trim()) process.stdout.write(`\n◆ ${event.content.trim()}\n`);
      break;
    case "tool-start":
      finishStreamLine();
      for (const call of event.calls) {
        process.stdout.write(`  → ${call.name} ${summarize(call.arguments)}\n`);
      }
      break;
    case "tool-result":
      process.stdout.write(
        `  ${event.result.ok ? "✓" : "✗"} ${event.result.name}: ${firstLine(event.result.content)}\n`
      );
      break;
    case "compaction":
      process.stdout.write(`  [compacted ${event.tokensBefore} → ${event.tokensAfter} tokens]\n`);
      break;
    case "error":
      process.stderr.write(`  error: ${event.message}\n`);
      break;
    case "usage":
      if (event.usd > 0) process.stdout.write(`  [$${event.usd.toFixed(4)}]\n`);
      break;
  }
}

function summarize(args: Record<string, unknown>): string {
  for (const key of ["command", "path", "pattern", "query"]) {
    if (typeof args[key] === "string") return String(args[key]).slice(0, 100);
  }
  return JSON.stringify(args).slice(0, 100);
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.slice(0, 120);
}

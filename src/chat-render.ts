import type { AgentEvent } from "./agent/loop.js";

/** Plain-text event renderer for the non-interactive `chat` command. */
export function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "assistant":
      if (event.content.trim()) process.stdout.write(`\n◆ ${event.content.trim()}\n`);
      break;
    case "tool-start":
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

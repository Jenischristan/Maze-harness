export class CommandParseError extends Error {}

export function parseCommandLine(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        current += input[i + 1]!;
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < input.length) {
        current += input[i + 1]!;
        i += 1;
        started = true;
        continue;
      }

      current += ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) {
    throw new CommandParseError(`unterminated ${quote} quote in command line: ${input}`);
  }
  if (started) out.push(current);
  return out;
}

export function quoteArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function argvJoin(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}

export function parseCommandSpec(input: string): string[] {
  const trimmed = input.trim();
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new CommandParseError(
        `command looks like JSON but does not parse: ${trimmed.slice(0, 200)}`
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((p) => typeof p === "string")
    ) {
      throw new CommandParseError("command JSON must be a non-empty array of strings");
    }
    return parsed as string[];
  }
  const argv = parseCommandLine(trimmed);
  if (argv.length === 0) throw new CommandParseError("command is empty");
  return argv;
}

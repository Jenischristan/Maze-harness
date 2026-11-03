/**
 * Structured logging with levels and a stable, greppable line format.
 *
 * Every long-running subsystem used to write to stderr ad hoc, which made
 * correlating a failure across run → round → turn → tool call impossible. All
 * diagnostics now go through one logger that:
 *
 *   - writes one line per record (`<ts> <level> <scope> <message> k=v ...`),
 *   - can emit newline-delimited JSON (`DREAM_LOG_FORMAT=json`),
 *   - carries a correlation context (run/round/turn/tool ids),
 *   - redacts secrets before serialising (see `redact.ts`).
 *
 * Logs go to stderr so stdout stays machine-parseable for `--json` commands.
 */
import { redactValue } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  level: LogLevel;
  scope: string;
  message: string;
  time: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

interface LoggerState {
  level: LogLevel;
  format: "text" | "json";
  sinks: LogSink[];
  context: Record<string, unknown>;
}

const state: LoggerState = {
  level: "info",
  format: "text",
  sinks: [],
  context: {}
};

/** Configure the process-wide logger. Later calls replace earlier settings. */
export function configureLogging(opts: {
  level?: LogLevel | string;
  format?: "text" | "json" | string;
}): void {
  if (opts.level !== undefined) state.level = parseLevel(opts.level);
  if (opts.format !== undefined) state.format = opts.format === "json" ? "json" : "text";
}

/** Configure from environment: DREAM_LOG_LEVEL and DREAM_LOG_FORMAT. */
export function configureLoggingFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  configureLogging({ level: env.DREAM_LOG_LEVEL, format: env.DREAM_LOG_FORMAT });
}

/** Add a sink (tests, in-process collectors). Defaults to stderr when empty. */
export function addLogSink(sink: LogSink): () => void {
  state.sinks.push(sink);
  return () => {
    const idx = state.sinks.indexOf(sink);
    if (idx >= 0) state.sinks.splice(idx, 1);
  };
}

export function currentLogLevel(): LogLevel {
  return state.level;
}

/**
 * Run `fn` with extra correlation fields on every record. Nested contexts
 * merge; a child cannot drop an inherited field by setting it to undefined.
 */
export async function withLogContext<T>(
  context: Record<string, unknown>,
  fn: () => Promise<T> | T
): Promise<T> {
  const previous = state.context;
  state.context = { ...previous, ...context };
  try {
    return await fn();
  } finally {
    state.context = previous;
  }
}

function parseLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? "info").toLowerCase();
  if (value in LEVELS) return value as LogLevel;
  // Never let a typo silently silence diagnostics: unknown values stay at info.
  return "info";
}

function isSecretKey(key: string): boolean {
  return /(?:api[_-]?key|token|secret|password|passwd|authorization|cookie)/i.test(key);
}

function serialise(record: LogRecord): string {
  if (state.format === "json") return JSON.stringify(record);
  const { level, scope, message, time, ...rest } = record;
  const fields = Object.keys(rest)
    .sort()
    .map((k) => {
      const v = rest[k];
      const text = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${text}`;
    })
    .join(" ");
  return `${time} ${level.toUpperCase()} ${scope} ${message}${fields ? ` ${fields}` : ""}`;
}

function emit(
  level: LogLevel,
  scope: string,
  message: string,
  fields: Record<string, unknown>
): void {
  if (LEVELS[level] < LEVELS[state.level]) return;
  const merged: Record<string, unknown> = { ...state.context };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    merged[k] = isSecretKey(k) ? "[REDACTED]" : redactValue(v);
  }
  const record: LogRecord = {
    level,
    scope,
    message,
    time: new Date().toISOString(),
    ...merged
  };
  if (state.sinks.length === 0) {
    process.stderr.write(`${serialise(record)}\n`);
    return;
  }
  for (const sink of state.sinks) sink(record);
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Create a logger bound to one scope (e.g. "loop.online", "tool.bash"). */
export function getLogger(scope: string, base: Record<string, unknown> = {}): Logger {
  return {
    debug: (message, fields) => emit("debug", scope, message, { ...base, ...fields }),
    info: (message, fields) => emit("info", scope, message, { ...base, ...fields }),
    warn: (message, fields) => emit("warn", scope, message, { ...base, ...fields }),
    error: (message, fields) => emit("error", scope, message, { ...base, ...fields }),
    child: (fields) => getLogger(scope, { ...base, ...fields })
  };
}

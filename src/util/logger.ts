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

export function configureLogging(opts: {
  level?: LogLevel | string;
  format?: "text" | "json" | string;
}): void {
  if (opts.level !== undefined) state.level = parseLevel(opts.level);
  if (opts.format !== undefined) state.format = opts.format === "json" ? "json" : "text";
}

export function configureLoggingFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  configureLogging({ level: env.DREAM_LOG_LEVEL, format: env.DREAM_LOG_FORMAT });
}

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

export function getLogger(scope: string, base: Record<string, unknown> = {}): Logger {
  return {
    debug: (message, fields) => emit("debug", scope, message, { ...base, ...fields }),
    info: (message, fields) => emit("info", scope, message, { ...base, ...fields }),
    warn: (message, fields) => emit("warn", scope, message, { ...base, ...fields }),
    error: (message, fields) => emit("error", scope, message, { ...base, ...fields }),
    child: (fields) => getLogger(scope, { ...base, ...fields })
  };
}

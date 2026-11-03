import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { modelInfo, type ModelInfo } from "./agent/models.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;

export const DEFAULT_BASE_URL = "http://127.0.0.1:8788/v1/chat/completions";
export const DEFAULT_MODEL = "deepseek-chat";

export const CONFIG_FILES = ["maze.json", "opencode.json", ".maze.json"];

export interface ProviderConfigEntry {
  api?: "chat" | "anthropic" | "responses";
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;

  models?: Record<string, Partial<ModelInfo>>;
}

export interface AgentConfigEntry {
  mode?: "build" | "plan";
  model?: string;
  prompt?: string;

  permission?: Record<string, "allow" | "ask" | "deny">;
  temperature?: number;
  tools?: Record<string, boolean>;
  maxTurns?: number;
}

export interface McpConfigEntry {
  type?: "local" | "remote";
  command?: string | string[];
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface FileConfig {
  model?: string;
  smallModel?: string;
  provider?: Record<string, ProviderConfigEntry>;
  agent?: Record<string, AgentConfigEntry>;

  instructions?: string[];
  mcp?: Record<string, McpConfigEntry>;
  permission?: Record<string, "allow" | "ask" | "deny">;

  sessionsDir?: string;
  temperature?: number;
  logLevel?: string;
  logFormat?: string;
}

export interface ResolvedConfig {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;

  modelId: string;

  providerId: string | undefined;
  contextWindow: number;
  logLevel: string;
  logFormat: string;

  agents: Record<string, AgentConfigEntry>;

  permission: Record<string, "allow" | "ask" | "deny">;
  instructions: string[];
  mcp: Record<string, McpConfigEntry>;
  temperature: number | undefined;
  sessionsDir: string | undefined;

  configPath: string | null;
}

export interface ConfigOverrides {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  contextWindow?: number;
  logLevel?: string;
  logFormat?: string;
  temperature?: number;
}

function envNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid ${key}: ${raw} (expected a positive number)`);
  }
  return Math.floor(n);
}

export function expandValue(value: string, root: string, env = process.env): string {
  return value
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "")
    .replace(/\{file:([^}]+)\}/g, (_, rel: string) => {
      const path = isAbsolute(rel) ? rel : join(root, rel);
      try {
        return readFileSync(path, "utf8").trim();
      } catch {
        return "";
      }
    });
}

function expandDeep<T>(value: T, root: string): T {
  if (typeof value === "string") return expandValue(value, root) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, root)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandDeep(v, root);
    return out as T;
  }
  return value;
}

export function findConfigFile(root = process.cwd(), env = process.env): string | null {
  if (env.MAZE_CONFIG) return resolve(env.MAZE_CONFIG);
  for (const name of CONFIG_FILES) {
    const path = join(resolve(root), name);
    if (existsSync(path)) return path;
  }
  return null;
}

export function loadFileConfig(
  root = process.cwd(),
  env = process.env
): { config: FileConfig; path: string | null } {
  const path = findConfigFile(root, env);
  if (!path) return { config: {}, path: null };
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid config ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object") return { config: {}, path };
  return { config: expandDeep(parsed as FileConfig, dirname(path)), path };
}

export function splitModel(spec: string): { provider?: string; model: string } {
  const i = spec.indexOf("/");
  if (i <= 0) return { model: spec };
  return { provider: spec.slice(0, i), model: spec.slice(i + 1) };
}

function providerFor(
  config: FileConfig,
  providerId: string | undefined
): ProviderConfigEntry | null {
  if (!providerId) return null;
  return config.provider?.[providerId] ?? null;
}

export function resolveConfig(
  overrides: ConfigOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
  root = process.cwd()
): ResolvedConfig {
  const { config, path } = loadFileConfig(root, env);
  const envWindow = envNumber(env, "DREAM_CONTEXT_WINDOW");
  const flagWindow =
    typeof overrides.contextWindow === "number" &&
    Number.isFinite(overrides.contextWindow) &&
    overrides.contextWindow > 0
      ? Math.floor(overrides.contextWindow)
      : undefined;

  const modelSpec = pick(overrides.model, env.DREAM_AGENT_MODEL, config.model, DEFAULT_MODEL);
  const { provider: providerId, model: modelId } = splitModel(modelSpec);
  const provider = providerFor(config, providerId);
  const modelOverride = provider?.models?.[modelId];
  const baseUrl = pick(overrides.baseUrl, env.DREAM_BASE_URL, provider?.baseURL, DEFAULT_BASE_URL);
  const info = modelInfo(modelId, modelOverride ?? {});
  return {
    baseUrl,
    apiKey: pickApiKey(overrides.apiKey, env, provider?.apiKey),
    model: modelSpec,
    modelId,
    providerId,
    contextWindow: flagWindow ?? envWindow ?? info.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    logLevel: pick(overrides.logLevel, env.DREAM_LOG_LEVEL, config.logLevel, "info"),
    logFormat: pick(overrides.logFormat, env.DREAM_LOG_FORMAT, config.logFormat, "text"),
    agents: config.agent ?? {},
    permission: config.permission ?? {},
    instructions: config.instructions ?? [],
    mcp: config.mcp ?? {},
    temperature: overrides.temperature ?? config.temperature,
    sessionsDir: config.sessionsDir,
    configPath: path
  };
}

function pick(...values: Array<string | undefined>): string {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

function pickApiKey(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  fromFile: string | undefined
): string | undefined {
  if (typeof flag === "string" && flag.length > 0) return flag;
  return (
    (env.DREAM_API_KEY && env.DREAM_API_KEY.length > 0 ? env.DREAM_API_KEY : undefined) ??
    (env.DEEPSEEK_ROUTER_KEY && env.DEEPSEEK_ROUTER_KEY.length > 0
      ? env.DEEPSEEK_ROUTER_KEY
      : undefined) ??
    (env.OPENAI_API_KEY && env.OPENAI_API_KEY.length > 0 ? env.OPENAI_API_KEY : undefined) ??
    (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.length > 0
      ? env.ANTHROPIC_API_KEY
      : undefined) ??
    (fromFile && fromFile.length > 0 ? fromFile : undefined)
  );
}

export function contextWindow(explicit?: number): number {
  return resolveConfig({ contextWindow: explicit }).contextWindow;
}

export function defaultBaseUrl(): string {
  return resolveConfig().baseUrl;
}

export function defaultApiKey(): string | undefined {
  return resolveConfig().apiKey;
}

export function defaultModel(): string {
  return resolveConfig().model;
}

export function contextPct(tokens: number, window = contextWindow()): number {
  if (window <= 0) return 0;
  return Math.min(1, Math.max(0, tokens / window));
}

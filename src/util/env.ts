export const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT"
] as const;

const CHILD_ENV_DENY_PREFIXES = [
  "DREAM_",
  "OPENAI_",
  "ANTHROPIC_",
  "DEEPSEEK_",
  "AWS_",
  "AZURE_",
  "GOOGLE_",
  "GCP_",
  "GITHUB_",
  "GH_",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_",
  "BASH_ENV",
  "ENV"
] as const;

export function isDeniedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  for (const prefix of CHILD_ENV_DENY_PREFIXES) {
    if (upper === prefix || upper.startsWith(prefix)) return true;
  }
  return false;
}

export function childEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string | undefined> = {},
  allowKeys: readonly string[] = []
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allow = new Set<string>([...CHILD_ENV_ALLOWLIST, ...allowKeys]);
  for (const key of allow) {
    if (isDeniedEnvKey(key)) continue;
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function taskChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return childEnv(source, { DREAM_CHILD: "1", ...extra });
}

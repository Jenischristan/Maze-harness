/**
 * Environment scrubbing for every child process the harness spawns.
 *
 * Untrusted surfaces (an MCP server declared by a cloned repository, a
 * discovery/policy agent CLI, an evaluator, a verification hook) were all
 * spawned with `{ ...process.env }`, so a hostile workspace could read the
 * provider API key straight out of its environment. Child processes now get an
 * allowlisted environment plus whatever the caller explicitly adds.
 *
 * This is *defence in depth*, not a security boundary: anything running with
 * the same uid can still read other state. It removes the accidental leak of
 * credentials into subprocesses, which is the realistic failure mode.
 */

/** Variables a child may inherit. Anything else is dropped. */
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

/**
 * Prefixes that are always dropped, even if they look like an allowlisted key.
 * These are the variables that commonly carry credentials or inject code into
 * child interpreters.
 */
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

/** True when a variable must never reach a child process. */
export function isDeniedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  for (const prefix of CHILD_ENV_DENY_PREFIXES) {
    if (upper === prefix || upper.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Build a scrubbed environment.
 *
 * @param source      environment to read (default: `process.env`)
 * @param extra       explicit additions/overrides the caller needs
 * @param allowKeys   additional keys to inherit even if not allowlisted
 */
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

/**
 * Environment a discovery agent, evaluator or hook should see: the child
 * allowlist plus a workspace marker. Provider credentials are deliberately not
 * included; tools that need a provider get it through the harness, not env.
 */
export function taskChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string | undefined> = {}
): NodeJS.ProcessEnv {
  return childEnv(source, { DREAM_CHILD: "1", ...extra });
}

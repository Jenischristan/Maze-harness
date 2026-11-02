export interface VerifyHook {
  name: string;
  /** Shell command run in the workspace after an edit. */
  command: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface HookResult {
  name: string;
  ok: boolean;
  output: string;
  timedOut: boolean;
  wallMs: number;
}

export interface HookRegistry {
  register(hook: VerifyHook): void;
  list(): VerifyHook[];
  /** Run every hook; `signal` aborts in-flight commands (e.g. on esc). */
  runAll(signal?: AbortSignal): Promise<HookResult[]>;
}

export interface VerifyHook {
  name: string;

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

  runAll(signal?: AbortSignal): Promise<HookResult[]>;
}

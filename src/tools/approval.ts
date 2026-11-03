import { DEFAULT_PERMISSION_POLICY, type PermissionPolicy } from "./permissions.js";

export type PermissionMode = "allow" | "ask" | "deny";

export interface ApprovalInput {
  tool: string;
  pattern: string;
  args: Record<string, unknown>;
}

export type ApprovalHandler = (input: ApprovalInput) => Promise<boolean>;

export function readLine(): Promise<string> {
  return new Promise((resolvePromise) => {
    const onData = (chunk: Buffer | string): void => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolvePromise(chunk.toString());
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

export const ttyApproval: ApprovalHandler = async (input) => {
  if (!process.stdin.isTTY) {
    process.stderr.write(`permission denied (no TTY to ask): ${input.tool} ${input.pattern}\n`);
    return false;
  }
  process.stderr.write(`permission required: ${input.tool} ${input.pattern} [y/N] `);
  const answer = await readLine();
  return /^y(es)?$/i.test(answer.trim());
};

export function buildPermissionPolicy(
  mode: string | undefined,
  approve: ApprovalHandler = ttyApproval
): PermissionPolicy {
  const action: PermissionPolicy["defaultAction"] =
    mode === "ask" ? "ask" : mode === "deny" ? "deny" : "allow";
  return { ...DEFAULT_PERMISSION_POLICY, defaultAction: action, ask: approve };
}

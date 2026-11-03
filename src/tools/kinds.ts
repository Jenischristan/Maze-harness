const READ_ONLY = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "page",
  "fetch",
  "webfetch",
  "websearch",
  "todo",
  "lsp",
  "question",
  "delegate"
]);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY.has(name);
}

const MUTATING = new Set(["edit", "write", "apply_patch", "multiedit", "bash"]);

export function isMutatingTool(name: string): boolean {
  return MUTATING.has(name);
}

export const READ_ONLY_TOOL_NAMES: readonly string[] = [...READ_ONLY];

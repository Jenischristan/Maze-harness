import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveryTree, ToolContext } from "../../src/types.js";
import type { PermissionPolicy } from "../../src/tools/permissions.js";

/**
 * Create a temp directory for a single test file.
 *
 * Call from `beforeEach`, assign the result to a file-scoped `dir` variable,
 * and pass the cleanup to `afterEach`:
 *
 *   let dir = "";
 *   let cleanup = () => Promise.resolve();
 *   beforeEach(async () => { dir = await makeTempDir("dh-deep"); });
 *   afterEach(() => cleanup());
 *
 * The helper returns both the directory and a remover so callers can compose
 * it with other teardown work.
 */
export async function makeTempDir(
  prefix = "dh-test"
): Promise<{ dir: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** No-op hooks object used by most `ToolContext` fixtures. */
const NOOP_HOOKS: ToolContext["hooks"] = {
  register: () => undefined,
  list: () => [],
  runAll: async () => []
};

/** Allow-everything permission policy with optional overrides. */
export function allowPolicy(overrides: Partial<PermissionPolicy> = {}): PermissionPolicy {
  return { defaultAction: "allow", rules: [], ...overrides };
}

/** Localhost-only network permission policy, for tests that spin up a server. */
export function localhostPolicy(overrides: Partial<PermissionPolicy> = {}): PermissionPolicy {
  return {
    defaultAction: "allow",
    rules: [],
    networkEnabled: true,
    networkAllowlist: ["127.0.0.1"],
    ...overrides
  };
}

/**
 * Build a `ToolContext` rooted at `dir`.
 *
 * Defaults are the common case: allow-all permissions, no-op hooks, and a
 * 32 KiB output cap. Pass `overrides` to replace any field.
 */
export function toolContext(dir: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: dir,
    readFiles: new Set(),
    readHashes: new Map(),
    modifiedFiles: new Set(),
    maxOutputBytes: 32 * 1024,
    permission: allowPolicy(),
    hooks: NOOP_HOOKS,
    ...overrides
  };
}

/** A minimal, empty `DiscoveryTree` for sandbox and loop tests. */
export function emptyTree(overrides: Partial<DiscoveryTree> = {}): DiscoveryTree {
  return {
    runId: "r",
    treeIndex: 0,
    baselineScore: 1,
    maxParallelism: 2,
    roundsLimit: 2,
    policyId: "p",
    createdAt: "t",
    nodes: [],
    ...overrides
  };
}

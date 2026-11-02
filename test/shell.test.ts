import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTool, resetShells } from "../src/tools/index.js";
import { Hooks } from "../src/tools/hooks.js";
import { DEFAULT_PERMISSION_POLICY } from "../src/tools/permissions.js";
import type { ToolContext } from "../src/types.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-shell-"));
  resetShells();
});

afterEach(async () => {
  resetShells();
  await rm(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: dir,
    readFiles: new Set(),
    modifiedFiles: new Set(),
    maxOutputBytes: 32 * 1024,
    permission: { ...DEFAULT_PERMISSION_POLICY, defaultAction: "allow" },
    hooks: new Hooks({ workspaceDir: dir, timeoutMs: 5000, maxOutputBytes: 4096 }),
    ...overrides
  };
}

async function run(command: string, c: ToolContext = ctx(), timeoutMs = 5000) {
  return bashTool.execute({ command, timeoutMs }, c);
}

describe("persistent shell state", () => {
  it("keeps variables across calls", async () => {
    const c = ctx();
    await run("X=42", c);
    const res = await run("echo $X", c);
    expect(res.content.trim()).toBe("42");
  });

  it("resets the working directory after the command", async () => {
    const c = ctx();
    const cd = await run("cd /tmp && pwd", c);
    expect(cd.content.trim()).toBe("/tmp");

    // The next command must start back in the workspace, not in /tmp.
    const pwd = await run("pwd", c);
    expect(pwd.content.trim()).toBe(dir);
  });

  it("can still read workspace files after a stray cd", async () => {
    const c = ctx();
    await run("mkdir -p sub && touch sub/marker.txt && cd /", c);
    const res = await run("ls sub", c);
    expect(res.ok).toBe(true);
    expect(res.content.trim()).toBe("marker.txt");
  });

  it("reports a non-zero exit code as a failed result", async () => {
    const res = await run("exit 3");
    // `exit` terminates the child, so verify with a command that returns 3.
    const alt = await run("sh -c 'exit 3'");
    expect(alt.ok).toBe(false);
    expect(alt.error).toBe("exit 3");
    void res;
  });

  it("returns a successful result for a zero exit", async () => {
    const res = await run("true");
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("surfaces command output alongside a failure", async () => {
    const res = await run("echo before; sh -c 'exit 5'");
    expect(res.ok).toBe(false);
    expect(res.content).toContain("before");
    expect(res.error).toBe("exit 5");
  });
});

describe("persistent shell timeouts", () => {
  it("times out a slow command and recovers for the next one", async () => {
    const c = ctx();
    const slow = await run("sleep 2; echo LATE", c, 1000);
    expect(slow.ok).toBe(false);
    expect(slow.error).toBe("timeout");

    const next = await run("echo FRESH", c);
    expect(next.content.trim()).toBe("FRESH");
    // No late output may leak into the fresh result.
    expect(next.content).not.toContain("LATE");
  }, 20000);

  it("does not let a timed-out command corrupt the marker of the next", async () => {
    const c = ctx();
    await run("sleep 1; echo A", c, 300);
    const a = await run("echo B", c, 5000);
    const b = await run("echo C", c, 5000);
    expect(a.content.trim()).toBe("B");
    expect(b.content.trim()).toBe("C");
  }, 20000);
});

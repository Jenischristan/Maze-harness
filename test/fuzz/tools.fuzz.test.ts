/**
 * Fuzz tests for filesystem and text primitives:
 *   src/tools/paths.ts, src/tools/truncate.ts, src/tools/permissions.ts
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveInside } from "../../src/tools/paths.js";
import { getPage, truncateOutput } from "../../src/tools/truncate.js";
import { DEFAULT_PERMISSION_POLICY, decide, networkAllowed } from "../../src/tools/permissions.js";
import { fuzzCases } from "./harness.js";

describe("fuzz: resolveInside containment", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dh-fuzz-paths-"));
    await mkdir(join(root, "ws/sub"), { recursive: true });
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside/secret"), "x");
    await symlink(join(root, "outside"), join(root, "ws/escape"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    "never returns a path outside the workspace",
    fuzzCases({ seed: 0xa11, runs: 200 }, (rng) => {
      const ws = join(root, "ws");
      const base = resolve(ws);
      const parts = ["", ".", "..", "sub", "escape", "a", "b", "x.txt", "\u00e9", "deep/er"];
      const rel = Array.from({ length: rng.int(0, 4) }, () => rng.pick(parts)).join("/");
      let out: string | null = null;
      try {
        out = resolveInside(ws, rel);
      } catch {
        out = null;
      }
      if (out !== null) {
        expect(out === base || out.startsWith(base + "/")).toBe(true);
        expect(out.startsWith(join(base, "escape"))).toBe(false);
      }
    })
  );
});

describe("fuzz: truncateOutput", () => {
  it(
    "respects the byte budget, is UTF-8 safe, and round-trips through getPage",
    fuzzCases({ seed: 0xa12, runs: 300 }, (rng) => {
      const text = rng.str(rng.int(0, 400));
      const maxBytes = rng.int(0, 300);
      const mode = rng.pick(["head", "tail"] as const);
      const res = truncateOutput(text, maxBytes, mode);
      const inputBytes = Buffer.byteLength(text);
      if (inputBytes <= maxBytes) {
        expect(res.truncated).toBe(false);
        expect(res.text).toBe(text);
        expect(res.keptBytes).toBe(inputBytes);
        expect(res.droppedBytes).toBe(0);
        return;
      }
      expect(res.truncated).toBe(true);
      expect(res.pageToken).toBeDefined();
      expect(getPage(res.pageToken!)).toBe(text);
      expect(res.keptBytes + res.droppedBytes).toBe(inputBytes);
      expect(res.keptBytes).toBeLessThanOrEqual(maxBytes);
      const body =
        mode === "tail"
          ? res.text.split("\n").slice(1).join("\n")
          : res.text.split("\n").slice(0, -1).join("\n");
      expect(body.includes("\uFFFD")).toBe(false);
      expect(res.text).toContain(`page=${res.pageToken}`);
    })
  );

  it("unknown tokens return null instead of throwing", () => {
    expect(getPage("nope")).toBeNull();
    expect(getPage("")).toBeNull();
  });
});

describe("fuzz: permissions", () => {
  it(
    "decide never throws and always resolves to allow/deny",
    fuzzCases({ seed: 0xa13, runs: 200 }, async (rng) => {
      const tool = rng.pick(["bash", "read", "write", "edit", "glob", "unknown"]);
      const args: Record<string, unknown> = rng.bool()
        ? { command: rng.str(60) }
        : { path: rng.str(40) };
      const d = await decide(DEFAULT_PERMISSION_POLICY, tool, args);
      expect(["allow", "deny"]).toContain(d.action);
      const pattern = rng.str(30);
      const d2 = await decide(
        { defaultAction: "allow", rules: [{ tool: "*", pattern, action: "deny" }] },
        tool,
        args
      );
      expect(["allow", "deny"]).toContain(d2.action);
    })
  );

  it(
    "dangerous defaults are never silently allowed without a handler",
    fuzzCases({ seed: 0xa14, runs: 60 }, async (rng) => {
      const dangerous = rng.pick([
        "rm -rf /",
        "sudo ls",
        "mkfs.ext4 /dev/sda",
        "git push origin main",
        "curl http://example.com"
      ]);
      const d = await decide(DEFAULT_PERMISSION_POLICY, "bash", { command: dangerous });
      expect(d.action).not.toBe("allow");
    })
  );

  it(
    "network allowlist uses exact-or-subdomain matching",
    fuzzCases({ seed: 0xa15, runs: 150 }, (rng) => {
      const allow = [rng.pick(["example.com", "api.test", "localhost"])];
      const policy = {
        defaultAction: "allow" as const,
        rules: [],
        networkEnabled: true,
        networkAllowlist: allow
      };
      const candidates = [
        `https://${allow[0]}/x`,
        `https://sub.${allow[0]}/x`,
        `https://evil.com/x`,
        "not a url",
        `http://${allow[0]}.evil.com/x`
      ];
      for (const url of candidates) {
        const ok = networkAllowed(policy, url);
        if (
          url.startsWith(`http://${allow[0]}.evil.com`) ||
          url.includes("evil.com") ||
          url === "not a url"
        ) {
          expect(ok).toBe(false);
        }
        if (url === `https://${allow[0]}/x` || url === `https://sub.${allow[0]}/x`) {
          expect(ok).toBe(true);
        }
      }
      expect(networkAllowed({ ...policy, networkEnabled: false }, `https://${allow[0]}/`)).toBe(
        false
      );
    })
  );
});

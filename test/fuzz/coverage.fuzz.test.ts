/**
 * Fuzz + integration coverage for modules that had no direct suite:
 *   src/chat-render.ts, src/developer/fake.ts, src/agents/toolAgent.ts,
 *   src/policies/sandboxRunner.ts (via sandbox + offline), src/loop/offline.ts.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { printEvent } from "../../src/chat-render.js";
import { FakePolicyDeveloper } from "../../src/developer/fake.js";
import { ToolAgent } from "../../src/agents/toolAgent.js";
import { ScriptedProvider } from "../../src/agent/provider.js";
import { evaluatePolicyOnTrees, runOfflinePhase } from "../../src/loop/offline.js";
import { compilePolicy } from "../../src/policies/loader.js";
import { RunStore } from "../../src/runs/store.js";
import { syntheticTree } from "../synthetic.js";
import type { AgentEvent } from "../../src/agent/loop.js";
import type { ReplayReport } from "../../src/types.js";
import { fuzzCases } from "./harness.js";

/* ------------------------------------------------------------------ */
/* chat-render                                                         */
/* ------------------------------------------------------------------ */

describe("fuzz: chat-render", () => {
  let out = "";
  let err = "";
  let outWrite: typeof process.stdout.write;
  let errWrite: typeof process.stderr.write;
  beforeEach(() => {
    out = "";
    err = "";
    outWrite = process.stdout.write.bind(process.stdout);
    errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      out += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      err += String(chunk);
      return true;
    }) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  });

  it(
    "renders every event kind without throwing",
    fuzzCases({ seed: 0xf01, runs: 80 }, (rng) => {
      const events: AgentEvent[] = [
        { type: "assistant", content: rng.str(40), toolCalls: [] },
        {
          type: "tool-start",
          calls: [{ id: "1", name: "bash", arguments: { command: rng.str(30) } }]
        },
        {
          type: "tool-result",
          result: { callId: "1", name: "read", ok: rng.bool(), content: rng.str(50) }
        },
        { type: "hooks", results: [] },
        { type: "compaction", tokensBefore: 10, tokensAfter: 2, summary: "s" },
        { type: "usage", promptTokens: 1, completionTokens: 2, usd: rng.next() },
        { type: "done", stopReason: "stop" },
        { type: "error", message: rng.str(30) }
      ];
      for (const ev of events) printEvent(ev);
      expect(out.length + err.length).toBeGreaterThan(0);
    })
  );

  it("only prints cost when usd is positive", () => {
    printEvent({ type: "usage", promptTokens: 0, completionTokens: 0, usd: 0 });
    expect(out).toBe("");
    printEvent({ type: "usage", promptTokens: 0, completionTokens: 0, usd: 0.5 });
    expect(out).toContain("$0.5000");
  });

  it("summarizes the first useful argument", () => {
    printEvent({
      type: "tool-start",
      calls: [{ id: "1", name: "bash", arguments: { command: "echo hi" } }]
    });
    expect(out).toContain("echo hi");
  });
});

/* ------------------------------------------------------------------ */
/* developer/fake                                                      */
/* ------------------------------------------------------------------ */

describe("fuzz: FakePolicyDeveloper", () => {
  it(
    "cycles variants, records calls, and returns the source when empty",
    fuzzCases({ seed: 0xf02, runs: 100 }, async (rng) => {
      const n = rng.int(0, 4);
      const variants = Array.from({ length: n }, () => `v${rng.int(0, 1_000_000)}`);
      const dev = new FakePolicyDeveloper({ variants });
      const initial = `initial-${rng.int(0, 99)}`;
      const revisions = rng.int(1, 6);
      let source = initial;
      for (let i = 0; i < revisions; i += 1) {
        source = await dev.revise({
          currentPolicySource: source,
          replayReports: [] as ReplayReport[],
          previousFeedback: [`f${i}`]
        });
        if (n === 0) expect(source).toBe(initial);
        else expect(source).toBe(variants[i % n]);
      }
      expect(dev.calls).toHaveLength(revisions);
    })
  );
});

/* ------------------------------------------------------------------ */
/* ToolAgent                                                           */
/* ------------------------------------------------------------------ */

describe("integration: ToolAgent", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dh-fuzz-agent-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(
    "runs an attempt, persists a session, and writes a transcript",
    fuzzCases({ seed: 0xf03, runs: 4, maxRuns: 4 }, async (rng) => {
      const ws = join(dir, `ws-${rng.int(0, 1_000_000)}`);
      const runsDir = join(dir, "runs");
      await mkdir(ws, { recursive: true });
      await writeFile(join(ws, "a.txt"), `content ${rng.int(0, 99)}`);
      const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
      const provider = new ScriptedProvider({
        model: "scripted",
        contextWindow: 100_000,
        turns: [
          {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.txt" } }]
            },
            usage,
            stopReason: "tool_calls"
          },
          {
            message: { role: "assistant", content: "done" },
            usage,
            stopReason: "stop"
          }
        ]
      });
      const agent = new ToolAgent({
        provider,
        runsDir,
        maxTurns: 5,
        enableMcp: false,
        permission: { defaultAction: "allow", rules: [] }
      });
      const nodeId = `b0a${rng.int(0, 9)}`;
      const res = await agent.run({
        workspaceDir: ws,
        task: { name: "t", description: "read a.txt" } as never,
        parent: null,
        context: {
          taskPrompt: "read a.txt",
          branch: 0,
          attempt: 0,
          nodeId,
          ancestorPath: []
        } as never
      });
      expect(res.transcriptPath).toBeDefined();
      const log = await readFile(res.transcriptPath!, "utf8");
      expect(log).toContain("# model scripted");
      expect(log).toContain("read a.txt");
      const sessions = await readdir(join(runsDir, "_sessions"));
      expect(sessions.length).toBeGreaterThan(0);
    })
  );
});

/* ------------------------------------------------------------------ */
/* offline phase (sandbox runner path)                                 */
/* ------------------------------------------------------------------ */

const POLICY_OK = `
export default class Policy {
  constructor(cfg) { this.beta = cfg.beta ?? 0; }
  async solve(env) {
    await env.probeBatch(["root"]);
    const leaves = env.legalActions().filter((id) => id !== "root");
    if (leaves.length && !env.done) await env.probeBatch(leaves.slice(0, 1));
  }
}
`;

describe("integration: offline phase", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dh-fuzz-offline-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(
    "compiles a policy, evaluates every tree, and selects a version",
    // The default vitest timeout is 30s and this case spawns one sandbox child
    // per (tree, beta) — 8 processes plus two compiles. Give it headroom so a
    // loaded machine does not turn a correct result into a timeout.
    { timeout: 120_000 },
    fuzzCases({ seed: 0xf04, runs: 1, maxRuns: 1 }, async (rng) => {
      const trees = Array.from({ length: rng.int(1, 2) }, (_, i) =>
        syntheticTree({
          seed: 100 + i + rng.int(0, 50),
          branches: 2,
          refinements: 2,
          maxParallelism: 2,
          roundsLimit: 4
        })
      );
      const compiled = await compilePolicy({
        source: POLICY_OK,
        outDir: join(dir, "pol"),
        policyId: "p"
      });
      expect(compiled.ok).toBe(true);
      expect(compiled.error).toBeNull();
      const bundlePath = compiled.bundlePath!;
      const reports = await evaluatePolicyOnTrees({
        policyId: "p",
        bundlePath,
        trees,
        histories: new Map(),
        scoreConfig: { beta1: 0.002, beta2: 0.01, normalize: "none" },
        sandbox: { timeoutMs: 20_000, memoryMb: 256 }
      });
      expect(reports).toHaveLength(trees.length);
      for (const r of reports) {
        expect(Number.isFinite(r.score)).toBe(true);
        expect(r.error).toBeNull();
      }

      const store = new RunStore({ rootDir: join(dir, "runs"), runId: "run-1" });
      await store.init();
      const dev = new FakePolicyDeveloper({ variants: [POLICY_OK] });
      const result = await runOfflinePhase({
        round: 1,
        currentPolicyId: "p",
        currentPolicySource: POLICY_OK,
        trees,
        histories: new Map(),
        developer: dev,
        store,
        revisions: 1,
        scoreConfig: { beta1: 0.002, beta2: 0.01, normalize: "none" },
        sandbox: { timeoutMs: 20_000, memoryMb: 256 },
        policyWorkDir: join(dir, "work"),
        betaGrid: [0, 1]
      });
      expect(result.records.length).toBeGreaterThanOrEqual(1);
      expect(result.selected).toBeDefined();
      expect(dev.calls).toHaveLength(1);
    })
  );
});

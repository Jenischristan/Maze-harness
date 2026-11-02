import { spawn } from "node:child_process";
import { collectText } from "./util/stream.js";
import type { Evaluator, EvaluatorResult, FailClass } from "./types.js";

export interface CommandEvaluatorConfig {
  command: string[];
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string>;
}

function classify(code: number | null, timedOut: boolean): FailClass {
  if (timedOut) return "timeout";
  if (code !== 0) return "runtime";
  return "ok";
}

export class CommandEvaluator implements Evaluator {
  private readonly cfg: CommandEvaluatorConfig;

  constructor(cfg: CommandEvaluatorConfig) {
    this.cfg = cfg;
  }

  async evaluate(workspaceDir: string, signal?: AbortSignal): Promise<EvaluatorResult> {
    const [cmd, ...args] = this.cfg.command;
    if (!cmd) {
      return {
        score: null,
        valid: false,
        failClass: "runtime",
        error: "evaluator command is empty",
        diagnostics: null
      };
    }
    const finalArgs = args.map((a) => a.replaceAll("{workspace}", workspaceDir));
    return new Promise<EvaluatorResult>((resolve) => {
      let timedOut = false;
      let aborted = false;
      if (signal?.aborted) {
        resolve({
          score: null,
          valid: false,
          failClass: "timeout",
          error: "evaluator aborted",
          diagnostics: null
        });
        return;
      }
      const child = spawn(cmd, finalArgs, {
        cwd: this.cfg.cwd ?? process.cwd(),
        env: { ...process.env, ...(this.cfg.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
      const kill = (): void => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const onAbort = (): void => {
        aborted = true;
        kill();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, this.cfg.timeoutMs);
      // StringDecoder keeps an incomplete trailing UTF-8 sequence intact; a
      // split multi-byte code point used to become U+FFFD in diagnostics.
      const outSink = collectText(child.stdout);
      const errSink = collectText(child.stderr);
      const settle = (): void => signal?.removeEventListener("abort", onAbort);
      child.on("error", (err) => {
        clearTimeout(timer);
        settle();
        resolve({
          score: null,
          valid: false,
          failClass: "runtime",
          error: `spawn failed: ${err.message}`,
          diagnostics: { stderr: errSink.flush() }
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        settle();
        if (aborted) {
          resolve({
            score: null,
            valid: false,
            failClass: "timeout",
            error: "evaluator aborted",
            diagnostics: { stdout: outSink.flush(), stderr: errSink.flush() }
          });
          return;
        }
        if (timedOut) {
          resolve({
            score: null,
            valid: false,
            failClass: "timeout",
            error: `evaluator exceeded ${this.cfg.timeoutMs}ms`,
            diagnostics: { stdout: outSink.flush(), stderr: errSink.flush() }
          });
          return;
        }
        const lines = outSink.flush()
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        const last = lines.at(-1);
        if (!last) {
          resolve({
            score: null,
            valid: false,
            failClass: classify(code, false),
            error: `evaluator produced no JSON line (exit ${code})`,
            diagnostics: { stdout: outSink.flush(), stderr: errSink.flush() }
          });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(last);
        } catch {
          resolve({
            score: null,
            valid: false,
            failClass: "runtime",
            error: "evaluator last line is not JSON",
            diagnostics: { stdout: outSink.flush(), stderr: errSink.flush() }
          });
          return;
        }
        resolve(parseEvaluatorJson(parsed, errSink.flush()));
      });
    });
  }
}

function parseEvaluatorJson(value: unknown, stderr = ""): EvaluatorResult {
  if (typeof value !== "object" || value === null) {
    return {
      score: null,
      valid: false,
      failClass: "runtime",
      error: "evaluator JSON must be an object",
      diagnostics: { stderr }
    };
  }
  const obj = value as Record<string, unknown>;
  const score =
    typeof obj.score === "number" && Number.isFinite(obj.score) ? obj.score : null;
  const valid = typeof obj.valid === "boolean" ? obj.valid : score !== null;
  const failClass =
    typeof obj.failClass === "string" ? obj.failClass : valid ? "ok" : "incorrect";
  const error = typeof obj.error === "string" ? obj.error : null;
  return {
    score,
    valid,
    failClass,
    error,
    diagnostics: obj.diagnostics ?? null
  };
}

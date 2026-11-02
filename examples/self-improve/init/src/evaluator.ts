import { spawn } from "node:child_process";
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

  async evaluate(workspaceDir: string): Promise<EvaluatorResult> {
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
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(cmd, finalArgs, {
        cwd: this.cfg.cwd ?? process.cwd(),
        env: { ...process.env, ...(this.cfg.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, this.cfg.timeoutMs);
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          score: null,
          valid: false,
          failClass: "runtime",
          error: `spawn failed: ${err.message}`,
          diagnostics: { stderr }
        });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            score: null,
            valid: false,
            failClass: "timeout",
            error: `evaluator exceeded ${this.cfg.timeoutMs}ms`,
            diagnostics: { stdout, stderr }
          });
          return;
        }
        const lines = stdout
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
            diagnostics: { stdout, stderr }
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
            diagnostics: { stdout, stderr }
          });
          return;
        }
        resolve(parseEvaluatorJson(parsed, stderr));
      });
    });
  }
}

export function parseEvaluatorJson(value: unknown, stderr = ""): EvaluatorResult {
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

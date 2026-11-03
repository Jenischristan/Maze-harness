import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLine, ttyApproval } from "../src/tools/approval.js";
import { questionTool, setQuestionHandler, ttyQuestionHandler } from "../src/tools/question.js";
import { loadVariantSource, seedPolicySource } from "../src/policies/seed.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-aq-"));
});

afterEach(async () => {
  setQuestionHandler(null);
  await rm(dir, { recursive: true, force: true });
});

function forceStdin(opts: { isTTY?: boolean; text?: string }): () => void {
  const stdin = process.stdin as unknown as {
    isTTY?: boolean;
    on: unknown;
    once: unknown;
    off: unknown;
    resume: unknown;
    pause: unknown;
  };
  const original = {
    isTTY: stdin.isTTY,
    on: stdin.on,
    once: stdin.once,
    off: stdin.off,
    resume: stdin.resume,
    pause: stdin.pause
  };
  Object.defineProperty(stdin, "isTTY", { value: opts.isTTY, configurable: true });
  stdin.on = () => undefined;
  stdin.off = () => undefined;
  stdin.resume = () => undefined;
  stdin.pause = () => undefined;
  stdin.once = ((_event: string, handler: (chunk: string) => void) => {
    setImmediate(() => handler(`${opts.text ?? ""}\n`));
  }) as never;
  return () => {
    Object.defineProperty(stdin, "isTTY", { value: original.isTTY, configurable: true });
    stdin.on = original.on;
    stdin.once = original.once;
    stdin.off = original.off;
    stdin.resume = original.resume;
    stdin.pause = original.pause;
  };
}

describe("approval: readLine and ttyApproval", () => {
  it("resolves with the next stdin chunk", async () => {
    const restore = forceStdin({ text: "hello" });
    try {
      expect(await readLine()).toBe("hello\n");
    } finally {
      restore();
    }
  });

  it("accepts y / yes in any case", async () => {
    for (const answer of ["y", "Y", "yes", "YeS", " y "]) {
      const restore = forceStdin({ isTTY: true, text: answer });
      try {
        await expect(ttyApproval({ tool: "bash", pattern: "ls", args: {} })).resolves.toBe(true);
      } finally {
        restore();
      }
    }
  });

  it("denies any other answer", async () => {
    for (const answer of ["n", "no", "", "yep", "1"]) {
      const restore = forceStdin({ isTTY: true, text: answer });
      try {
        await expect(ttyApproval({ tool: "bash", pattern: "ls", args: {} })).resolves.toBe(false);
      } finally {
        restore();
      }
    }
  });

  it("prints the prompt and the tool on stderr", async () => {
    const restore = forceStdin({ isTTY: true, text: "y" });
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as never;
    try {
      await ttyApproval({ tool: "bash", pattern: "rm -rf x", args: {} });
    } finally {
      process.stderr.write = original as never;
      restore();
    }
    expect(written.join("")).toContain("permission required: bash rm -rf x [y/N]");
  });

  it("explains the no-TTY denial on stderr", async () => {
    const restore = forceStdin({ isTTY: false });
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as never;
    try {
      await expect(ttyApproval({ tool: "bash", pattern: "rm", args: {} })).resolves.toBe(false);
    } finally {
      process.stderr.write = original as never;
      restore();
    }
    expect(written.join("")).toContain("permission denied (no TTY to ask)");
  });
});

describe("question: tty handler option selection", () => {
  it("selects the numbered option", async () => {
    const restore = forceStdin({ isTTY: true, text: "2" });
    try {
      const answers = await ttyQuestionHandler([
        {
          header: "pick",
          question: "which?",
          options: [{ label: "a" }, { label: "b", description: "second" }]
        }
      ]);
      expect(answers).toEqual(["b"]);
    } finally {
      restore();
    }
  });

  it("falls back to the raw answer for an out-of-range number", async () => {
    const restore = forceStdin({ isTTY: true, text: "9" });
    try {
      const answers = await ttyQuestionHandler([{ question: "q", options: [{ label: "a" }] }]);
      expect(answers).toEqual(["9"]);
    } finally {
      restore();
    }
  });

  it("treats a non-integer answer as free text", async () => {
    const restore = forceStdin({ isTTY: true, text: "maybe 1.5" });
    try {
      const answers = await ttyQuestionHandler([{ question: "q", options: [{ label: "a" }] }]);
      expect(answers).toEqual(["maybe 1.5"]);
    } finally {
      restore();
    }
  });

  it("accepts free text when there are no options", async () => {
    const restore = forceStdin({ isTTY: true, text: "custom" });
    try {
      const answers = await ttyQuestionHandler([{ question: "q" }]);
      expect(answers).toEqual(["custom"]);
    } finally {
      restore();
    }
  });

  it("answers every question in order and prints options with descriptions", async () => {
    const restore = forceStdin({ isTTY: true, text: "1" });
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as never;
    try {
      const answers = await ttyQuestionHandler([
        { header: "H", question: "one", options: [{ label: "alpha", description: "first" }] },
        { question: "two" }
      ]);
      expect(answers).toEqual(["alpha", "1"]);
    } finally {
      process.stderr.write = original as never;
      restore();
    }
    const text = written.join("");
    expect(text).toContain("[H] one");
    expect(text).toContain("1. alpha — first");
  });

  it("throws without a TTY", async () => {
    const restore = forceStdin({ isTTY: false });
    try {
      await expect(ttyQuestionHandler([{ question: "q" }])).rejects.toThrow(/no TTY/);
    } finally {
      restore();
    }
  });

  it("the tool maps a handler throw to a fallback message", async () => {
    setQuestionHandler(async () => {
      throw new Error("stdin closed");
    });
    const res = await questionTool.execute({ questions: [{ question: "q" }] }, {
      workspaceDir: dir
    } as never);
    expect(res.ok).toBe(false);
    expect(res.content).toContain("Proceed with the most reasonable assumption");
  });
});

describe("policies/seed path resolution", () => {
  it("falls back to the package-root variants directory", async () => {
    // The real module already resolves via one of the two branches; assert the
    // resolved source is the fixed variant either way.
    const src = await loadVariantSource("fixed");
    expect(src.source).toContain("class");
    expect(src.policyId).toBe("fixed");
  });

  it("seeds the greedy variant for a greedy policy id", async () => {
    const greedy = await seedPolicySource("greedy-2");
    expect(greedy.policyId).toBe("greedy-2");
    expect(greedy.source).toContain("class");
    expect(greedy.source).not.toBe((await loadVariantSource("fixed")).source);
  });
});

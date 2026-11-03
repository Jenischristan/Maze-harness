import type { ToolDefinition, ToolResult } from "../types.js";
import { readLine } from "./approval.js";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiple?: boolean;
}

export type QuestionHandler = (questions: Question[]) => Promise<string[]>;

let handler: QuestionHandler | null = null;

export function setQuestionHandler(fn: QuestionHandler | null): void {
  handler = fn;
}

export const ttyQuestionHandler: QuestionHandler = async (questions) => {
  const answers: string[] = [];
  for (const q of questions) {
    if (!process.stdin.isTTY) throw new Error("no TTY to ask a question");
    process.stderr.write(`\n? ${q.header ? `[${q.header}] ` : ""}${q.question}\n`);
    for (const [i, o] of (q.options ?? []).entries()) {
      process.stderr.write(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}\n`);
    }
    process.stderr.write("> ");
    const raw = (await readLine()).trim();
    const n = Number(raw);
    if (
      q.options &&
      q.options.length > 0 &&
      Number.isInteger(n) &&
      n >= 1 &&
      n <= q.options.length
    ) {
      answers.push(q.options[n - 1]!.label);
    } else {
      answers.push(raw);
    }
  }
  return answers;
};

export const questionTool: ToolDefinition = {
  name: "question",
  description:
    "Ask the user one or more questions and wait for the answers. Use it when a decision cannot be inferred from the repository. Provide options for a choice; the user may still type a free-form answer.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            multiple: { type: "boolean" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" }
                },
                required: ["label"],
                additionalProperties: false
              }
            }
          },
          required: ["question"],
          additionalProperties: false
        }
      }
    },
    required: ["questions"],
    additionalProperties: false
  },
  async execute(args): Promise<ToolResult> {
    const questions = Array.isArray(args.questions) ? (args.questions as Question[]) : [];
    if (questions.length === 0) {
      return {
        callId: "",
        name: "question",
        ok: false,
        content: "question requires at least one question",
        error: "no-questions"
      };
    }
    const ask = handler ?? ttyQuestionHandler;
    try {
      const answers = await ask(questions);
      return {
        callId: "",
        name: "question",
        ok: true,
        content: questions
          .map((q, i) => `${q.header ? `${q.header}: ` : ""}${q.question}\n→ ${answers[i] ?? ""}`)
          .join("\n\n"),
        data: { answers }
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        callId: "",
        name: "question",
        ok: false,
        content: `cannot ask: ${message}. Proceed with the most reasonable assumption and state it.`,
        error: "no-answer-handler"
      };
    }
  }
};

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolDefinition, ToolResult } from "../types.js";

export interface TodoItem {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

const FILE = ".maze/todos.json";

async function pathFor(ctx: { workspaceDir: string }): Promise<string> {
  return join(ctx.workspaceDir, FILE);
}

export async function readTodos(workspaceDir: string): Promise<TodoItem[]> {
  const path = join(workspaceDir, FILE);
  const raw = await readFile(path, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as { todos?: TodoItem[] };
    return Array.isArray(parsed.todos) ? parsed.todos : [];
  } catch {
    return [];
  }
}

export function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "(no todos)";
  const mark = (s: TodoItem["status"]): string =>
    s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : s === "cancelled" ? "[-]" : "[ ]";
  const done = todos.filter((t) => t.status === "completed").length;
  return [
    `Progress: ${done}/${todos.length}`,
    ...todos.map((t, i) => `${i + 1}. ${mark(t.status)} ${t.content}`)
  ].join("\n");
}

export const todoTool: ToolDefinition = {
  name: "todo",
  description:
    "Read or replace the task todo list. Call with no arguments to read; call with `todos` to replace the whole list. Use it to plan multi-step work and keep progress visible across turns.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "Replacement list. Omit to read the current list.",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"]
            }
          },
          required: ["content", "status"],
          additionalProperties: false
        }
      }
    },
    additionalProperties: false
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!Array.isArray(args.todos)) {
      const todos = await readTodos(ctx.workspaceDir);
      return {
        callId: "",
        name: "todo",
        ok: true,
        content: renderTodos(todos),
        data: { todos }
      };
    }
    const todos = (args.todos as TodoItem[]).map((t) => ({
      content: String(t.content ?? ""),
      status: (["pending", "in_progress", "completed", "cancelled"] as const).includes(t.status)
        ? t.status
        : "pending"
    }));
    const path = await pathFor(ctx);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ todos }, null, 2), "utf8");
    return {
      callId: "",
      name: "todo",
      ok: true,
      content: `updated todos\n${renderTodos(todos)}`,
      data: { todos }
    };
  }
};

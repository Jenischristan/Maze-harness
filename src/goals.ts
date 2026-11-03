import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./util/atomic.js";

type GoalStatus = "active" | "done" | "paused";

export interface Goal {
  id: string;
  title: string;
  detail: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;

  sessionId?: string;
}

interface GoalStore {
  dir: string;
  path: string;
  goals: Goal[];
  load(): Promise<void>;
  save(): Promise<void>;
  add(title: string, detail?: string, sessionId?: string): Goal;
  update(id: string, patch: Partial<Pick<Goal, "status" | "detail" | "title">>): Goal | null;
  remove(id: string): boolean;
  active(sessionId?: string): Goal | null;
  forSession(sessionId: string | undefined): Goal[];
  find(prefix: string): Goal | null;
}

export class FileGoalStore implements GoalStore {
  readonly dir: string;
  readonly path: string;
  goals: Goal[] = [];

  constructor(runsDir: string) {
    this.dir = resolve(runsDir);
    this.path = join(this.dir, "goals.json");
  }

  async load(): Promise<void> {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (Array.isArray(raw)) {
        this.goals = raw.filter(isGoal);
      }
    } catch {
      this.goals = [];
    }
  }

  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    await writeFileAtomic(this.path, `${JSON.stringify(this.goals, null, 2)}\n`);
  }

  add(title: string, detail = "", sessionId?: string): Goal {
    const now = new Date().toISOString();
    const goal: Goal = {
      id: randomUUID().slice(0, 8),
      title: title.trim() || "untitled goal",
      detail: detail.trim(),
      status: "active",
      createdAt: now,
      updatedAt: now,
      sessionId
    };

    for (const g of this.goals) {
      if (g.status === "active" && g.sessionId === sessionId) g.status = "paused";
    }
    this.goals.push(goal);
    return goal;
  }

  update(id: string, patch: Partial<Pick<Goal, "status" | "detail" | "title">>): Goal | null {
    const goal = this.find(id);
    if (!goal) return null;
    if (patch.status === "active") {
      for (const g of this.goals) {
        if (g.id !== goal.id && g.status === "active" && g.sessionId === goal.sessionId) {
          g.status = "paused";
        }
      }
    }
    if (patch.status) goal.status = patch.status;
    if (patch.title !== undefined) goal.title = patch.title;
    if (patch.detail !== undefined) goal.detail = patch.detail;
    goal.updatedAt = new Date().toISOString();
    return goal;
  }

  remove(id: string): boolean {
    const prefix = id.trim();
    // An empty id must never match (startsWith("") is always true and would
    // silently delete the first goal). Ambiguous prefixes are rejected too.
    if (!prefix) return false;
    const exact = this.goals.findIndex((g) => g.id === prefix);
    if (exact !== -1) {
      this.goals.splice(exact, 1);
      return true;
    }
    const matches = this.goals.filter((g) => g.id.startsWith(prefix));
    if (matches.length !== 1) return false;
    const idx = this.goals.findIndex((g) => g.id === matches[0]!.id);
    if (idx === -1) return false;
    this.goals.splice(idx, 1);
    return true;
  }

  active(sessionId?: string): Goal | null {
    if (sessionId === undefined) {
      return this.goals.find((g) => g.status === "active") ?? null;
    }
    return this.goals.find((g) => g.status === "active" && g.sessionId === sessionId) ?? null;
  }

  forSession(sessionId: string | undefined): Goal[] {
    if (!sessionId) return [];
    return this.goals.filter((g) => g.sessionId === sessionId);
  }

  find(prefix: string): Goal | null {
    if (!prefix) return null;
    return (
      this.goals.find((g) => g.id === prefix) ??
      this.goals.find((g) => g.id.startsWith(prefix)) ??
      null
    );
  }
}

function isGoal(value: unknown): value is Goal {
  if (!value || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;
  return (
    typeof g.id === "string" &&
    typeof g.title === "string" &&
    typeof g.status === "string" &&
    typeof g.createdAt === "string"
  );
}

export function goalSection(goal: Goal | null): string {
  if (!goal) return "";
  const lines = [`## Active goal (${goal.id})`, `**${goal.title}**`];
  if (goal.detail.trim()) lines.push("", goal.detail.trim());
  lines.push(
    "",
    "Work toward this goal. When every requirement is satisfied and verification passes, reply with `GOAL COMPLETE` followed by a short summary."
  );
  return lines.join("\n");
}

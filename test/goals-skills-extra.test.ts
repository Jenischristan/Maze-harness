import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileGoalStore } from "../src/goals.js";
import { discoverSkills, findSkill, skillPrompt } from "../src/skills.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dh-goal-skill-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("goals: lifecycle and edge cases", () => {
  async function store(): Promise<FileGoalStore> {
    const s = new FileGoalStore(dir);
    await s.load();
    return s;
  }

  it("starts empty and persists a goal", async () => {
    const s = await store();
    const goal = s.add("ship it", "details");
    await s.save();
    const reloaded = await store();
    expect(reloaded.goals).toHaveLength(1);
    expect(reloaded.goals[0]).toMatchObject({
      title: "ship it",
      detail: "details",
      status: "active"
    });
    expect(goal.id).toMatch(/[0-9a-f-]{8,}/);
  });

  it("only one goal is active per session", async () => {
    const s = await store();
    const a = s.add("a", "", "s1");
    const b = s.add("b", "", "s1");
    s.update(b.id, { status: "active" });
    expect(s.find(a.id)!.status).toBe("paused");
    expect(s.active("s1")!.id).toBe(b.id);
    expect(s.active("s2")).toBeNull();
    expect(s.active()).toBeTruthy();
  });

  it("updates title and detail", async () => {
    const s = await store();
    const g = s.add("t");
    const updated = s.update(g.id, { title: "new", detail: "d" });
    expect(updated).toMatchObject({ title: "new", detail: "d" });
    expect(s.update("nope", { title: "x" })).toBeNull();
  });

  it("removes by exact id, unique prefix, and refuses empty or ambiguous ids", async () => {
    const s = await store();
    const a = s.add("a");
    expect(s.remove("")).toBe(false);
    expect(s.remove(a.id)).toBe(true);
    const b = s.add("b");
    expect(s.remove(b.id.slice(0, 4))).toBe(true);
    const c = s.add("c");
    const d = s.add("d");
    // force a shared prefix to exercise the ambiguity guard
    c.id = "shared-1";
    d.id = "shared-2";
    expect(s.remove("shared")).toBe(false);
    expect(s.goals).toHaveLength(2);
  });

  it("forSession filters by session and rejects a missing session", async () => {
    const s = await store();
    s.add("a", "", "s1");
    s.add("b", "", "s2");
    expect(s.forSession("s1")).toHaveLength(1);
    expect(s.forSession(undefined)).toEqual([]);
  });

  it("find accepts an exact id or a unique prefix", async () => {
    const s = await store();
    const g = s.add("x");
    expect(s.find(g.id)).not.toBeNull();
    expect(s.find(g.id.slice(0, 5))!.id).toBe(g.id);
    expect(s.find("zzz")).toBeNull();
  });

  it("reloads an empty store from corrupt or non-array data", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "goals.json"), "{nope");
    expect((await store()).goals).toEqual([]);
    await writeFile(join(dir, "goals.json"), JSON.stringify({ goals: [] }));
    expect((await store()).goals).toEqual([]);
  });

  it("drops malformed records on load", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "goals.json"),
      JSON.stringify([
        { id: "1", title: "ok", detail: "", status: "active", createdAt: "t", updatedAt: "t" },
        { id: 2, title: "bad" },
        { id: "3", title: "bad-status", status: "weird" }
      ])
    );
    const s = await store();
    expect(s.goals.map((g) => g.title)).toEqual(["ok"]);
  });
});

describe("skills: discovery and frontmatter", () => {
  async function skill(file: string, content: string): Promise<void> {
    const path = join(dir, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }

  it("parses frontmatter name, description and allowed tools", async () => {
    await skill(
      "skills/one/SKILL.md",
      [
        "---",
        "name: one",
        "description: first",
        "allowed-tools: [read, grep]",
        "---",
        "# Body",
        "text"
      ].join("\n")
    );
    const skills = await discoverSkills(dir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "one",
      description: "first",
      allowedTools: ["read", "grep"]
    });
  });

  it("falls back to the directory name and first body line", async () => {
    await skill("skills/plain/SKILL.md", "# Heading\nmore\n");
    const [s] = await discoverSkills(dir);
    expect(s!.name).toBe("plain");
    expect(s!.description).toBe("Heading");
  });

  it("supports a top-level markdown skill file", async () => {
    await skill("skills/solo.md", "Solo body\n");
    const [s] = await discoverSkills(dir);
    expect(s!.name).toBe("solo");
  });

  it("strips a BOM and quoted values", async () => {
    await skill(
      "skills/quoted/SKILL.md",
      "\uFEFF---\nname: \"q\"\ndescription: 'desc'\n---\nbody\n"
    );
    const [s] = await discoverSkills(dir);
    expect(s).toMatchObject({ name: "q", description: "desc" });
  });

  it("skips empty bodies and files without frontmatter terminators", async () => {
    await skill("skills/empty/SKILL.md", "---\nname: e\n---\n\n");
    await skill("skills/unterminated/SKILL.md", "---\nname: u\nno end\n");
    const skills = await discoverSkills(dir);
    expect(skills.some((s) => s.name === "e")).toBe(false);
    // An unterminated frontmatter is treated as body text.
    expect(skills.some((s) => s.name === "unterminated")).toBe(true);
  });

  it("dedupes by name across directories, keeping the first", async () => {
    await skill(".dream/skills/x/SKILL.md", "first\n");
    await skill("skills/x/SKILL.md", "second\n");
    const [s] = await discoverSkills(dir);
    expect(s!.body).toBe("first");
  });

  it("returns nothing when no skill directory exists", async () => {
    expect(await discoverSkills(dir)).toEqual([]);
  });

  it("finds a skill by name and by prefix", async () => {
    const skills = [
      { name: "review", description: "d", body: "b", path: "p" },
      { name: "review-deep", description: "d", body: "b", path: "p" }
    ];
    expect(findSkill(skills, "review")!.name).toBe("review");
    expect(findSkill(skills, "review-d")!.name).toBe("review-deep");
    expect(findSkill(skills, "")).toBeNull();
    expect(findSkill(skills, "zzz")).toBeNull();
  });

  it("renders the skill prompt", () => {
    expect(skillPrompt({ name: "s", description: "d", body: "BODY", path: "p" })).toContain("BODY");
  });
});

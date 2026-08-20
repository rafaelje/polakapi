import { describe, expect, it } from "vitest";
import { filterSkills } from "./filter";
import type { SkillEntry } from "./types";

function skill(partial: Partial<SkillEntry>): SkillEntry {
  return {
    cli: "claude",
    name: "changelog",
    description: "Generate a changelog",
    path: "/home/u/.claude/skills/changelog/SKILL.md",
    source: "~/.claude/skills",
    ...partial,
  };
}

describe("filterSkills", () => {
  const skills = [
    skill({ name: "changelog" }),
    skill({ cli: "cursor", name: "canvas", description: "Draw things" }),
    skill({ cli: "codex", name: "review", description: "Review PRs" }),
  ];

  it("returns a copy of everything for an empty query", () => {
    const result = filterSkills(skills, "  ");
    expect(result).toEqual(skills);
    expect(result).not.toBe(skills);
  });

  it("matches by name", () => {
    expect(filterSkills(skills, "canvas")).toHaveLength(1);
  });

  it("matches by cli", () => {
    expect(filterSkills(skills, "codex")).toHaveLength(1);
    expect(filterSkills(skills, "codex")[0].name).toBe("review");
  });

  it("matches by description case-insensitively", () => {
    expect(filterSkills(skills, "DRAW")).toHaveLength(1);
  });

  it("requires every token to match", () => {
    expect(filterSkills(skills, "cursor canvas")).toHaveLength(1);
    expect(filterSkills(skills, "cursor review")).toHaveLength(0);
  });
});

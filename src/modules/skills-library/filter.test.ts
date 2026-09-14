import { describe, expect, it } from "vitest";
import {
  filterSkills,
  skillGroupLabel,
  skillScopeOptions,
  sortSkills,
  SCOPE_ALL,
  SCOPE_GLOBAL,
} from "./filter";
import { formatElapsed } from "./skills-modal";
import type { SkillEntry } from "./types";

function skill(partial: Partial<SkillEntry>): SkillEntry {
  return {
    cli: "claude",
    name: "changelog",
    description: "Generate a changelog",
    path: "/home/u/.claude/skills/changelog/SKILL.md",
    source: "~/.claude/skills",
    scope: "global",
    projectPath: null,
    ...partial,
  };
}

const projectSkill = (partial: Partial<SkillEntry> = {}) =>
  skill({
    scope: "project",
    projectPath: "/home/u/repos/polakapi",
    source: "polakapi/.claude/skills",
    ...partial,
  });

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

  it("narrows to general skills or to a single project", () => {
    const mixed = [skill({ name: "changelog" }), projectSkill({ name: "deploy" })];
    expect(filterSkills(mixed, "", SCOPE_ALL)).toHaveLength(2);
    expect(filterSkills(mixed, "", SCOPE_GLOBAL).map((s) => s.name)).toEqual(["changelog"]);
    expect(filterSkills(mixed, "", "/home/u/repos/polakapi").map((s) => s.name)).toEqual([
      "deploy",
    ]);
    expect(filterSkills(mixed, "", "/home/u/repos/other")).toHaveLength(0);
  });

  it("still applies the text query inside the chosen scope", () => {
    const mixed = [skill({ name: "changelog" }), projectSkill({ name: "deploy" })];
    expect(filterSkills(mixed, "changelog", SCOPE_GLOBAL)).toHaveLength(1);
    expect(filterSkills(mixed, "deploy", SCOPE_GLOBAL)).toHaveLength(0);
  });
});

describe("skillGroupLabel", () => {
  it("names the repo for project skills and stays generic otherwise", () => {
    expect(skillGroupLabel(projectSkill({}))).toBe("project · polakapi");
    expect(skillGroupLabel(skill({}))).toBe("general skills");
  });
});

describe("sortSkills", () => {
  it("puts the active repo first, then other repos, then general skills", () => {
    const sorted = sortSkills(
      [
        skill({ name: "global-one" }),
        projectSkill({ name: "other", projectPath: "/home/u/repos/other" }),
        projectSkill({ name: "active" }),
      ],
      "/home/u/repos/polakapi",
    );
    expect(sorted.map((s) => s.name)).toEqual(["active", "other", "global-one"]);
  });

  it("falls back to cli then name inside a group", () => {
    const sorted = sortSkills(
      [skill({ cli: "codex", name: "zeta" }), skill({ cli: "codex", name: "alpha" })],
      null,
    );
    expect(sorted.map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("skillScopeOptions", () => {
  it("counts every scope and marks the active project", () => {
    const options = skillScopeOptions(
      [
        skill({ name: "a" }),
        skill({ name: "b" }),
        projectSkill({ name: "c" }),
        projectSkill({ name: "d", projectPath: "/home/u/repos/other" }),
      ],
      "/home/u/repos/polakapi",
    );
    expect(options.map((o) => [o.value, o.label, o.count])).toEqual([
      [SCOPE_ALL, "all skills", 4],
      [SCOPE_GLOBAL, "general only", 2],
      ["/home/u/repos/polakapi", "polakapi (current)", 1],
      ["/home/u/repos/other", "other", 1],
    ]);
  });

  it("lists only the scopes that exist", () => {
    const options = skillScopeOptions([skill({})], null);
    expect(options).toHaveLength(2);
  });
});

describe("formatElapsed", () => {
  it("counts seconds, then switches to m:ss past a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(12_400)).toBe("12s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1:00");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_605_000)).toBe("60:05");
  });

  it("never renders a negative reading from a clock skew", () => {
    expect(formatElapsed(-5_000)).toBe("0s");
  });
});

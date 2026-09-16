import { describe, expect, it } from "vitest";
import {
  buildRows,
  encodeProjectDir,
  filterRows,
  projectOptions,
  ALL_PROJECTS,
  type MemoryProjectGroup,
} from "./types";

const file = (name: string, isIndex = false) => ({
  name,
  description: `${name} description`,
  path: `/home/u/.claude/projects/x/memory/${name}`,
  isIndex,
});

const groups: MemoryProjectGroup[] = [
  {
    dirName: "-home-u-repos-alpha",
    files: [file("zeta.md"), file("MEMORY.md", true)],
  },
  {
    dirName: "-home-u-repos-beta",
    files: [file("beta-fact.md")],
  },
];

describe("encodeProjectDir", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(encodeProjectDir("/home/u/repos/alpha")).toBe("-home-u-repos-alpha");
    expect(encodeProjectDir("/home/u/my.repo_2")).toBe("-home-u-my-repo-2");
  });
});

describe("buildRows", () => {
  it("puts the active project first and its index before other files", () => {
    const rows = buildRows(
      groups,
      ["/home/u/repos/alpha", "/home/u/repos/beta"],
      "/home/u/repos/beta",
    );
    expect(rows.map((r) => r.file.name)).toEqual(["beta-fact.md", "MEMORY.md", "zeta.md"]);
    expect(rows[0].isActiveProject).toBe(true);
    expect(rows[0].projectLabel).toBe("/home/u/repos/beta");
    expect(rows[1].file.isIndex).toBe(true);
  });

  it("falls back to the dir name when no known project matches", () => {
    const rows = buildRows(groups, [], null);
    expect(rows[0].projectLabel).toBe("-home-u-repos-alpha");
    expect(rows.every((r) => !r.isActiveProject)).toBe(true);
  });
});

describe("filterRows", () => {
  it("matches on file name, description and project label", () => {
    const rows = buildRows(groups, ["/home/u/repos/beta"], null);
    expect(filterRows(rows, "beta-fact").length).toBe(1);
    expect(filterRows(rows, "repos/beta").length).toBe(1);
    expect(filterRows(rows, "ZETA.MD description").length).toBe(1);
    expect(filterRows(rows, "").length).toBe(3);
    expect(filterRows(rows, "nope").length).toBe(0);
  });
});

describe("projectOptions", () => {
  it("counts one option per project and marks the active one", () => {
    const rows = buildRows(
      groups,
      ["/home/u/repos/alpha", "/home/u/repos/beta"],
      "/home/u/repos/beta",
    );
    expect(projectOptions(rows).map((o) => [o.value, o.label, o.count])).toEqual([
      [ALL_PROJECTS, "all projects", 3],
      ["-home-u-repos-beta", "beta (current)", 1],
      ["-home-u-repos-alpha", "alpha", 2],
    ]);
  });

  it("falls back to the munged dir name when the project is unknown", () => {
    const rows = buildRows(groups, [], null);
    expect(projectOptions(rows)[1].label).toBe("-home-u-repos-alpha");
  });
});

describe("filterRows by project", () => {
  const rows = buildRows(groups, ["/home/u/repos/alpha", "/home/u/repos/beta"], null);

  it("keeps only the rows of the selected project", () => {
    expect(filterRows(rows, "", "-home-u-repos-alpha").map((r) => r.file.name)).toEqual([
      "MEMORY.md",
      "zeta.md",
    ]);
    expect(filterRows(rows, "", "-home-u-repos-beta")).toHaveLength(1);
    expect(filterRows(rows, "", "-home-u-nope")).toHaveLength(0);
  });

  it("combines the project with the text query", () => {
    expect(filterRows(rows, "zeta", "-home-u-repos-alpha")).toHaveLength(1);
    expect(filterRows(rows, "zeta", "-home-u-repos-beta")).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import type { BranchFile, BranchRefs } from "../types";
import {
  BASE_PLACEHOLDER,
  baseOptionGroups,
  branchFileGroup,
  branchFileTarget,
  listViewFrom,
  resolveBase,
} from "./branch-tab-model";

const refs: BranchRefs = {
  current: "feature",
  local: ["feature", "main"],
  remote: [
    { name: "origin/main", remote: "origin", branch: "main" },
    { name: "origin/release", remote: "origin", branch: "release" },
  ],
};

function branchFile(overrides: Partial<BranchFile> & Pick<BranchFile, "path">): BranchFile {
  return {
    originalPath: null,
    status: "modified",
    insertions: 0,
    deletions: 0,
    binary: false,
    ...overrides,
  };
}

describe("base picker", () => {
  it("uses the placeholder text required by the spec", () => {
    expect(BASE_PLACEHOLDER).toBe("select the base branch for the diff");
  });

  it("lists local and every remote branch as base options", () => {
    expect(baseOptionGroups(refs, "main")).toEqual([
      { label: "Local", options: ["feature", "main"] },
      { label: "Remote", options: ["origin/main", "origin/release"] },
    ]);
  });

  it("keeps a selected base that is no longer listed", () => {
    const groups = baseOptionGroups({ current: null, local: ["dev"], remote: [] }, "main");
    expect(groups).toEqual([{ label: "Local", options: ["dev", "main"] }]);
  });

  it("omits empty groups", () => {
    expect(baseOptionGroups({ current: null, local: [], remote: [] }, null)).toEqual([]);
  });

  it("prefers the base the user picked over the default", () => {
    expect(resolveBase("develop", "main")).toBe("develop");
    expect(resolveBase(null, "main")).toBe("main");
    expect(resolveBase(null, null)).toBeNull();
  });
});

describe("files / processes toggle", () => {
  it("reads the view from the toggle button", () => {
    expect(listViewFrom("processes")).toBe("processes");
    expect(listViewFrom("files")).toBe("files");
    expect(listViewFrom(undefined)).toBe("files");
  });
});

describe("branch file list", () => {
  it("groups the files under the base branch with totals", () => {
    const files = [
      branchFile({ path: "b.ts", insertions: 2, deletions: 1 }),
      branchFile({ path: "a.ts", insertions: 3 }),
    ];

    const group = branchFileGroup(files, "main");

    expect(group.label).toBe("vs main");
    expect(group.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(group.count).toBe(2);
    expect(group.keys).toEqual(["branch:a.ts", "branch:b.ts"]);
  });

  it("builds a branch diff target that carries the base", () => {
    const file = branchFile({ path: "new.ts", originalPath: "old.ts", status: "renamed" });

    expect(branchFileTarget(file, "origin/main")).toEqual({
      key: "branch:new.ts",
      path: "new.ts",
      originalPath: "old.ts",
      status: "renamed",
      source: { kind: "branch", base: "origin/main" },
    });
  });
});

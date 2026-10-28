import { describe, expect, it } from "vitest";
import type { BranchRefs, ChangedFile } from "../types";
import { branchSwitchGroups, switchBlockReason } from "./branch-switch-model";

function change(path: string, group: ChangedFile["group"]): ChangedFile {
  return {
    path,
    originalPath: null,
    group,
    status: group === "untracked" ? "untracked" : "modified",
    insertions: 1,
    deletions: 0,
    binary: false,
  };
}

const refs: BranchRefs = {
  current: "main",
  local: ["develop", "feature/login", "main"],
  remote: [
    { name: "origin/feature/login", remote: "origin", branch: "feature/login" },
    { name: "origin/feature/search", remote: "origin", branch: "feature/search" },
    { name: "origin/main", remote: "origin", branch: "main" },
    { name: "upstream/release", remote: "upstream", branch: "release" },
  ],
};

describe("switchBlockReason", () => {
  it("allows switching on a clean working tree", () => {
    expect(switchBlockReason([])).toBeNull();
  });

  it("explains how many files block the switch, counting a partially staged file once", () => {
    const reason = switchBlockReason([
      change("src/a.ts", "staged"),
      change("src/a.ts", "unstaged"),
      change("notes.md", "untracked"),
    ]);

    expect(reason).toBe("Commit or discard your 2 changed files before switching branches.");
  });

  it("uses the singular for one changed file", () => {
    expect(switchBlockReason([change("a.ts", "unstaged")])).toBe(
      "Commit or discard your 1 changed file before switching branches.",
    );
  });
});

describe("branchSwitchGroups", () => {
  it("lists local branches with the current one flagged, then remote-only branches", () => {
    const groups = branchSwitchGroups(refs, "");

    expect(groups).toEqual([
      {
        label: "Local",
        options: [
          { ref: "develop", label: "develop", current: false },
          { ref: "feature/login", label: "feature/login", current: false },
          { ref: "main", label: "main", current: true },
        ],
      },
      {
        label: "Remote",
        options: [
          { ref: "origin/feature/search", label: "origin/feature/search", current: false },
          { ref: "upstream/release", label: "upstream/release", current: false },
        ],
      },
    ]);
  });

  it("filters by a case-insensitive substring and drops empty groups", () => {
    const groups = branchSwitchGroups(refs, "  SEARCH ");

    expect(groups).toEqual([
      {
        label: "Remote",
        options: [{ ref: "origin/feature/search", label: "origin/feature/search", current: false }],
      },
    ]);
  });

  it("returns no groups when nothing matches", () => {
    expect(branchSwitchGroups(refs, "nope")).toEqual([]);
  });
});

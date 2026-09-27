import { describe, expect, it } from "vitest";
import { codeReviewKeyAction } from "../code-review-model";
import type { ChangedFile } from "../types";
import { discardPaths, discardStep } from "./discard";

function file(overrides: Partial<ChangedFile> & Pick<ChangedFile, "path" | "group">): ChangedFile {
  return {
    originalPath: null,
    status: "modified",
    insertions: 0,
    deletions: 0,
    binary: false,
    ...overrides,
  };
}

describe("discard key", () => {
  it("maps d to discard", () => {
    expect(codeReviewKeyAction({ key: "d" })).toBe("discard");
    expect(codeReviewKeyAction({ key: "d", ctrlKey: true })).toBeNull();
  });
});

describe("discardStep", () => {
  it("arms the selected row on the first d without discarding", () => {
    expect(discardStep(null, "unstaged:a.ts", "discard")).toEqual({
      armed: "unstaged:a.ts",
      confirmed: null,
    });
  });

  it("confirms the armed row on a second d and disarms", () => {
    expect(discardStep("unstaged:a.ts", "unstaged:a.ts", "discard")).toEqual({
      armed: null,
      confirmed: "unstaged:a.ts",
    });
  });

  it("re-arms instead of discarding when the selection moved to another row", () => {
    expect(discardStep("unstaged:a.ts", "staged:b.ts", "discard")).toEqual({
      armed: "staged:b.ts",
      confirmed: null,
    });
  });

  it("disarms on any other key, including unmapped ones", () => {
    for (const action of [
      "next",
      "previous",
      "refresh",
      "toggle-stage",
      "stage-all",
      null,
    ] as const) {
      expect(discardStep("unstaged:a.ts", "unstaged:a.ts", action)).toEqual({
        armed: null,
        confirmed: null,
      });
    }
  });

  it("does nothing without a selection", () => {
    expect(discardStep(null, null, "discard")).toEqual({ armed: null, confirmed: null });
    expect(discardStep("unstaged:a.ts", null, "discard")).toEqual({
      armed: null,
      confirmed: null,
    });
  });
});

describe("discardPaths", () => {
  it("discards the row's path", () => {
    expect(discardPaths(file({ path: "a.ts", group: "untracked" }))).toEqual(["a.ts"]);
  });

  it("discards both sides of a rename", () => {
    const renamed = file({ path: "new.ts", originalPath: "old.ts", group: "staged" });
    expect(discardPaths(renamed)).toEqual(["new.ts", "old.ts"]);
  });
});

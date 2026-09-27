import { describe, expect, it } from "vitest";
import {
  buildCodeReviewUrl,
  codeReviewKeyAction,
  codeReviewWindowLabel,
  fileKey,
  groupChanges,
  moveSelection,
  readPinnedProject,
  reconcileSelection,
  spaceAction,
  visibleFileKeys,
} from "./code-review-model";
import type { ChangedFile } from "./types";

function file(overrides: Partial<ChangedFile> & Pick<ChangedFile, "path" | "group">): ChangedFile {
  return {
    originalPath: null,
    status: overrides.group === "untracked" ? "untracked" : "modified",
    insertions: 0,
    deletions: 0,
    binary: false,
    ...overrides,
  };
}

const files: ChangedFile[] = [
  file({ path: "src/b.ts", group: "unstaged", insertions: 3, deletions: 1 }),
  file({ path: "src/a.ts", group: "staged", insertions: 2 }),
  file({ path: "notes.md", group: "untracked", insertions: 5 }),
  file({ path: "src/a.ts", group: "unstaged", deletions: 4 }),
  file({ path: "lib/new.ts", group: "staged", status: "added", insertions: 10 }),
];

describe("groupChanges", () => {
  it("groups files into staged, unstaged and untracked with counts", () => {
    const groups = groupChanges(files);

    expect(groups.map((g) => [g.group, g.label, g.count])).toEqual([
      ["staged", "Staged", 2],
      ["unstaged", "Unstaged", 2],
      ["untracked", "Untracked", 1],
    ]);
    expect(groups[0].files.map((f) => f.path)).toEqual(["lib/new.ts", "src/a.ts"]);
    expect(groups[1].files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(groups[0].insertions).toBe(12);
    expect(groups[1].deletions).toBe(5);
  });

  it("keeps a partially staged file in both staged and unstaged", () => {
    const groups = groupChanges(files);
    expect(groups[0].files.some((f) => f.path === "src/a.ts")).toBe(true);
    expect(groups[1].files.some((f) => f.path === "src/a.ts")).toBe(true);
    expect(fileKey(groups[0].files[1])).not.toBe(fileKey(groups[1].files[0]));
  });

  it("returns empty groups for a clean tree", () => {
    expect(groupChanges([]).map((g) => g.count)).toEqual([0, 0, 0]);
  });
});

describe("keyboard selection", () => {
  const keys = visibleFileKeys(groupChanges(files));

  it("lists keys in display order", () => {
    expect(keys).toEqual([
      "staged:lib/new.ts",
      "staged:src/a.ts",
      "unstaged:src/a.ts",
      "unstaged:src/b.ts",
      "untracked:notes.md",
    ]);
  });

  it("moves down and up across groups and clamps at the ends", () => {
    expect(moveSelection(keys, "staged:src/a.ts", 1)).toBe("unstaged:src/a.ts");
    expect(moveSelection(keys, "unstaged:src/a.ts", -1)).toBe("staged:src/a.ts");
    expect(moveSelection(keys, "untracked:notes.md", 1)).toBe("untracked:notes.md");
    expect(moveSelection(keys, "staged:lib/new.ts", -1)).toBe("staged:lib/new.ts");
  });

  it("starts at the first or last file when nothing is selected", () => {
    expect(moveSelection(keys, null, 1)).toBe("staged:lib/new.ts");
    expect(moveSelection(keys, null, -1)).toBe("untracked:notes.md");
    expect(moveSelection([], null, 1)).toBeNull();
  });

  it("keeps the selection after a refresh when the file is still listed", () => {
    expect(reconcileSelection(keys, "unstaged:src/b.ts")).toBe("unstaged:src/b.ts");
    expect(reconcileSelection(keys, "unstaged:gone.ts")).toBe("staged:lib/new.ts");
    expect(reconcileSelection([], "unstaged:gone.ts")).toBeNull();
  });
});

describe("codeReviewKeyAction", () => {
  const press = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
    codeReviewKeyAction({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  it("maps arrows and j/k to selection moves", () => {
    expect(press("ArrowDown")).toBe("next");
    expect(press("j")).toBe("next");
    expect(press("ArrowUp")).toBe("previous");
    expect(press("k")).toBe("previous");
  });

  it("maps r to refresh and escape to close", () => {
    expect(press("r")).toBe("refresh");
    expect(press("Escape")).toBe("close");
  });

  it("maps space to toggle staging and a to stage all", () => {
    expect(press(" ")).toBe("toggle-stage");
    expect(press("a")).toBe("stage-all");
    expect(press("a", { ctrlKey: true })).toBeNull();
  });

  it("ignores modified keys and unrelated keys", () => {
    expect(press("r", { ctrlKey: true })).toBeNull();
    expect(press("r", { metaKey: true })).toBeNull();
    expect(press("j", { altKey: true })).toBeNull();
    expect(press("x")).toBeNull();
  });
});

describe("pinned project", () => {
  it("round-trips the project through the window url", () => {
    const project = { path: "/home/me/my repo", name: "my repo & co" };
    const url = buildCodeReviewUrl(project);

    expect(url.startsWith("code-review.html?")).toBe(true);
    expect(readPinnedProject(url.slice(url.indexOf("?")))).toEqual(project);
  });

  it("returns null when the project path is missing", () => {
    expect(readPinnedProject("")).toBeNull();
    expect(readPinnedProject("?name=x")).toBeNull();
  });

  it("falls back to the folder name when the name is missing", () => {
    expect(readPinnedProject("?project=%2Fcode%2Fapp")).toEqual({ path: "/code/app", name: "app" });
  });

  it("gives each project path its own stable window label", () => {
    const a = codeReviewWindowLabel("/code/app");
    expect(a).toMatch(/^code-review-[0-9a-f]+$/);
    expect(codeReviewWindowLabel("/code/app")).toBe(a);
    expect(codeReviewWindowLabel("/code/other")).not.toBe(a);
  });
});

describe("spaceAction", () => {
  it("unstages a staged row", () => {
    expect(spaceAction(file({ path: "a.ts", group: "staged" }))).toEqual({
      kind: "unstage",
      paths: ["a.ts"],
    });
  });

  it("stages an unstaged or untracked row", () => {
    expect(spaceAction(file({ path: "a.ts", group: "unstaged" }))).toEqual({
      kind: "stage",
      paths: ["a.ts"],
    });
    expect(spaceAction(file({ path: "new.ts", group: "untracked" }))).toEqual({
      kind: "stage",
      paths: ["new.ts"],
    });
  });

  it("unstages both sides of a staged rename", () => {
    const renamed = file({
      path: "new.ts",
      originalPath: "old.ts",
      group: "staged",
      status: "renamed",
    });
    expect(spaceAction(renamed)).toEqual({ kind: "unstage", paths: ["new.ts", "old.ts"] });
  });

  it("does nothing without a selected row", () => {
    expect(spaceAction(null)).toBeNull();
  });
});

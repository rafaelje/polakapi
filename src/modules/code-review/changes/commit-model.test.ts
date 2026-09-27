import { describe, expect, it } from "vitest";
import { canCommit, isCommitShortcut } from "./commit-model";

describe("canCommit", () => {
  it("allows a commit with staged files and a message", () => {
    expect(canCommit({ stagedCount: 2, message: "fix: typo", busy: false })).toBe(true);
  });

  it("refuses when nothing is staged", () => {
    expect(canCommit({ stagedCount: 0, message: "fix: typo", busy: false })).toBe(false);
  });

  it("refuses an empty or whitespace-only message", () => {
    expect(canCommit({ stagedCount: 1, message: "", busy: false })).toBe(false);
    expect(canCommit({ stagedCount: 1, message: " \n\t", busy: false })).toBe(false);
  });

  it("refuses while another action is running", () => {
    expect(canCommit({ stagedCount: 1, message: "fix: typo", busy: true })).toBe(false);
  });
});

describe("isCommitShortcut", () => {
  it("accepts ctrl+enter and cmd+enter", () => {
    expect(isCommitShortcut({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(isCommitShortcut({ key: "Enter", metaKey: true })).toBe(true);
  });

  it("ignores a plain or alt enter and other keys", () => {
    expect(isCommitShortcut({ key: "Enter" })).toBe(false);
    expect(isCommitShortcut({ key: "Enter", ctrlKey: true, altKey: true })).toBe(false);
    expect(isCommitShortcut({ key: "a", ctrlKey: true })).toBe(false);
  });
});

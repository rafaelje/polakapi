import { describe, expect, it } from "vitest";
import { diffContents, sideBySideRows, type DiffRow } from "./diff-model";

const context = (left: number, right: number, text: string): DiffRow => ({
  kind: "context",
  left: { number: left, text },
  right: { number: right, text },
});
const deleted = (left: number, text: string): DiffRow => ({
  kind: "deleted",
  left: { number: left, text },
  right: null,
});
const added = (right: number, text: string): DiffRow => ({
  kind: "added",
  left: null,
  right: { number: right, text },
});
const modified = (left: number, before: string, right: number, after: string): DiffRow => ({
  kind: "modified",
  left: { number: left, text: before },
  right: { number: right, text: after },
});

describe("sideBySideRows", () => {
  it("pairs a changed line and keeps the surrounding context", () => {
    expect(sideBySideRows("a\nb\nc\n", "a\nB\nc\n")).toEqual([
      context(1, 1, "a"),
      modified(2, "b", 2, "B"),
      context(3, 3, "c"),
    ]);
  });

  it("shows inserted lines with an empty left side and shifts the new numbers", () => {
    expect(sideBySideRows("a\nd\n", "a\nb\nc\nd\n")).toEqual([
      context(1, 1, "a"),
      added(2, "b"),
      added(3, "c"),
      context(2, 4, "d"),
    ]);
  });

  it("shows removed lines with an empty right side", () => {
    expect(sideBySideRows("a\nb\nc\n", "a\nc\n")).toEqual([
      context(1, 1, "a"),
      deleted(2, "b"),
      context(3, 2, "c"),
    ]);
  });

  it("pairs as many lines as possible when a block is replaced by one of a different size", () => {
    expect(sideBySideRows("x\nold1\nold2\nold3\ny\n", "x\nnew1\ny\n")).toEqual([
      context(1, 1, "x"),
      modified(2, "old1", 2, "new1"),
      deleted(3, "old2"),
      deleted(4, "old3"),
      context(5, 3, "y"),
    ]);
    expect(sideBySideRows("x\nold\ny\n", "x\nnew1\nnew2\ny\n")).toEqual([
      context(1, 1, "x"),
      modified(2, "old", 2, "new1"),
      added(3, "new2"),
      context(3, 4, "y"),
    ]);
  });

  it("keeps the longest common subsequence as context", () => {
    const rows = sideBySideRows("a\nb\nc\nd\ne\n", "b\nx\nd\ne\nf\n");
    expect(rows.filter((row) => row.kind === "context").map((row) => row.left?.text)).toEqual([
      "b",
      "d",
      "e",
    ]);
    expect(rows).toEqual([
      deleted(1, "a"),
      context(2, 1, "b"),
      modified(3, "c", 2, "x"),
      context(4, 3, "d"),
      context(5, 4, "e"),
      added(5, "f"),
    ]);
  });

  it("renders an added file as only added rows", () => {
    expect(sideBySideRows(null, "one\ntwo\n")).toEqual([added(1, "one"), added(2, "two")]);
  });

  it("renders a deleted file as only deleted rows", () => {
    expect(sideBySideRows("one\ntwo\n", null)).toEqual([deleted(1, "one"), deleted(2, "two")]);
  });

  it("renders an unchanged renamed file as context rows", () => {
    expect(sideBySideRows("one\ntwo", "one\ntwo")).toEqual([
      context(1, 1, "one"),
      context(2, 2, "two"),
    ]);
  });

  it("ignores line ending differences and keeps blank lines", () => {
    expect(sideBySideRows("a\r\n\r\nb\r\n", "a\n\nb\n")).toEqual([
      context(1, 1, "a"),
      context(2, 2, ""),
      context(3, 3, "b"),
    ]);
  });

  it("returns no rows for two empty sides", () => {
    expect(sideBySideRows("", null)).toEqual([]);
  });

  it("handles large files with scattered edits", () => {
    const before = Array.from({ length: 5000 }, (_, index) => `line ${index}`);
    const after = before.map((line, index) => (index % 500 === 0 ? `${line} changed` : line));
    const rows = sideBySideRows(before.join("\n"), after.join("\n"));
    expect(rows).toHaveLength(5000);
    expect(rows.filter((row) => row.kind === "modified")).toHaveLength(10);
    expect(rows[500]).toEqual(modified(501, "line 500", 501, "line 500 changed"));
  });

  it("still produces a complete diff when the files share nothing", () => {
    const before = Array.from({ length: 3000 }, (_, index) => `a${index}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, index) => `b${index}`).join("\n");
    const rows = sideBySideRows(before, after);
    expect(rows).toHaveLength(3000);
    expect(rows.every((row) => row.kind === "modified")).toBe(true);
  });
});

describe("diffContents", () => {
  it("computes rows when both sides are text or absent", () => {
    expect(
      diffContents({ before: { kind: "absent" }, after: { kind: "text", text: "x\n" } }),
    ).toEqual({ kind: "rows", rows: [added(1, "x")] });
  });

  it("returns a placeholder when either side is binary", () => {
    expect(
      diffContents({ before: { kind: "text", text: "x" }, after: { kind: "binary" } }),
    ).toEqual({ kind: "placeholder", message: "Binary file, no text diff to show." });
  });

  it("returns a placeholder with the size when either side is too large", () => {
    expect(
      diffContents({
        before: { kind: "tooLarge", bytes: 3 * 1024 * 1024 },
        after: { kind: "absent" },
      }),
    ).toEqual({ kind: "placeholder", message: "File is too large to show (3.0 MB)." });
  });
});

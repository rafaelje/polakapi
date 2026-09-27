import { describe, expect, it } from "vitest";
import {
  diffContents,
  foldRows,
  sideBySideRows,
  unifiedRows,
  wordRanges,
  type DiffRow,
  type TextRange,
} from "./diff-model";

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
  left: { number: left, text: before, changes: expect.any(Array) as TextRange[] },
  right: { number: right, text: after, changes: expect.any(Array) as TextRange[] },
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

describe("wordRanges", () => {
  it("marks only the changed word on both sides", () => {
    expect(wordRanges("const a = 1;", "const b = 1;")).toEqual({
      left: [{ start: 6, end: 7 }],
      right: [{ start: 6, end: 7 }],
    });
  });

  it("merges neighbouring changed tokens into one range", () => {
    expect(wordRanges("call(bar)", "call(baz, qux)")).toEqual({
      left: [{ start: 5, end: 8 }],
      right: [{ start: 5, end: 13 }],
    });
  });

  it("reports pure insertions only on the side that has them", () => {
    expect(wordRanges("a b", "a x b")).toEqual({ left: [], right: [{ start: 2, end: 4 }] });
  });

  it("attaches the ranges to modified rows", () => {
    const [row] = sideBySideRows("let x = 1;\n", "let y = 1;\n");
    expect(row.left?.changes).toEqual([{ start: 4, end: 5 }]);
    expect(row.right?.changes).toEqual([{ start: 4, end: 5 }]);
  });
});

const numbered = (count: number, changedAt: number): [string, string] => {
  const before = Array.from({ length: count }, (_, index) => `line ${index + 1}`);
  const after = before.map((line, index) => (index === changedAt ? `${line}!` : line));
  return [before.join("\n"), after.join("\n")];
};

describe("foldRows", () => {
  it("folds unchanged regions beyond three context lines around a change", () => {
    const rows = sideBySideRows(...numbered(20, 9));
    expect(foldRows(rows)).toEqual([
      { kind: "fold", start: 0, end: 6 },
      ...[6, 7, 8, 9, 10, 11, 12].map((index) => ({ kind: "row", index })),
      { kind: "fold", start: 13, end: 20 },
    ]);
  });

  it("shows a fold's rows once it is expanded", () => {
    const rows = sideBySideRows(...numbered(20, 9));
    const items = foldRows(rows, new Set([0]));
    expect(items.slice(0, 7)).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((index) => ({ kind: "row", index })),
    );
    expect(items[items.length - 1]).toEqual({ kind: "fold", start: 13, end: 20 });
  });

  it("keeps short unchanged gaps between changes visible", () => {
    const [before] = numbered(10, -1);
    const after = before.replace("line 2", "line two").replace("line 9", "line nine");
    expect(foldRows(sideBySideRows(before, after))).toEqual(
      Array.from({ length: 10 }, (_, index) => ({ kind: "row", index })),
    );
  });

  it("folds the middle of a long gap between two changes", () => {
    const [before] = numbered(12, -1);
    const after = before.replace("line 1\n", "line one\n").replace("line 12", "line twelve");
    expect(foldRows(sideBySideRows(before, after))).toEqual([
      ...[0, 1, 2, 3].map((index) => ({ kind: "row", index })),
      { kind: "fold", start: 4, end: 8 },
      ...[8, 9, 10, 11].map((index) => ({ kind: "row", index })),
    ]);
  });

  it("does not fold a single hidden line", () => {
    const rows = sideBySideRows(...numbered(5, 4));
    expect(foldRows(rows)).toEqual([0, 1, 2, 3, 4].map((index) => ({ kind: "row", index })));
  });
});

describe("unifiedRows", () => {
  it("lists a changed block as its deletions followed by its additions", () => {
    const rows = unifiedRows(sideBySideRows("a\nb\nc\n", "a\nB\nX\nc\n"));
    expect(rows).toEqual([
      { kind: "context", oldNumber: 1, newNumber: 1, text: "a" },
      {
        kind: "deleted",
        oldNumber: 2,
        newNumber: null,
        text: "b",
        changes: [{ start: 0, end: 1 }],
      },
      { kind: "added", oldNumber: null, newNumber: 2, text: "B", changes: [{ start: 0, end: 1 }] },
      { kind: "added", oldNumber: null, newNumber: 3, text: "X" },
      { kind: "context", oldNumber: 3, newNumber: 4, text: "c" },
    ]);
  });

  it("renders an added file as only added lines", () => {
    expect(unifiedRows(sideBySideRows(null, "x\n"))).toEqual([
      { kind: "added", oldNumber: null, newNumber: 1, text: "x" },
    ]);
  });

  it("folds with the same rules as the side-by-side rows", () => {
    const rows = unifiedRows(sideBySideRows(...numbered(20, 9)));
    expect(foldRows(rows)[0]).toEqual({ kind: "fold", start: 0, end: 6 });
    expect(rows[9].kind).toBe("deleted");
    expect(rows[10].kind).toBe("added");
  });
});

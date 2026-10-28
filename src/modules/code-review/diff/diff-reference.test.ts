import { describe, expect, it } from "vitest";
import { sideBySideRows, unifiedRows } from "./diff-model";
import { formatReference, sideSelection, unifiedSelection } from "./diff-reference";

const rows = sideBySideRows("a\nb\nc\nd\n", "a\nB\nX\nc\nd\n");

describe("sideSelection", () => {
  it("takes the after lines of the selected rows on the right side", () => {
    expect(sideSelection(rows, "right", 1, 3)).toEqual({
      side: "after",
      lines: [
        { number: 2, text: "B" },
        { number: 3, text: "X" },
        { number: 4, text: "c" },
      ],
    });
  });

  it("skips empty cells and uses before numbers on the left side", () => {
    expect(sideSelection(rows, "left", 3, 1)).toEqual({
      side: "before",
      lines: [
        { number: 2, text: "b" },
        { number: 3, text: "c" },
      ],
    });
  });

  it("returns nothing when only empty cells are selected", () => {
    expect(sideSelection(rows, "left", 2, 2)).toBeNull();
  });
});

describe("unifiedSelection", () => {
  const unified = unifiedRows(rows);

  it("uses the new numbers when the selection includes added or context lines", () => {
    expect(unifiedSelection(unified, 0, 3)).toEqual({
      side: "after",
      lines: [
        { number: 1, text: "a" },
        { number: 2, text: "B" },
        { number: 3, text: "X" },
      ],
    });
  });

  it("uses the old numbers for a selection of deleted lines only", () => {
    expect(unifiedSelection(unified, 1, 1)).toEqual({
      side: "before",
      lines: [{ number: 2, text: "b" }],
    });
  });
});

describe("formatReference", () => {
  it("formats an after selection with its range and a fenced snippet", () => {
    const selection = sideSelection(rows, "right", 1, 2);
    expect(formatReference("src/app.ts", selection!)).toBe(
      "src/app.ts:2-3 (after)\n```ts\nB\nX\n```\n",
    );
  });

  it("uses a single line number for a one-line selection", () => {
    expect(
      formatReference("lib.rs", { side: "after", lines: [{ number: 7, text: "fn a() {}" }] }),
    ).toBe("lib.rs:7 (after)\n```rust\nfn a() {}\n```\n");
  });

  it("labels before selections and adds the base branch when given", () => {
    const selection = { side: "before" as const, lines: [{ number: 2, text: "b" }] };
    expect(formatReference("a.py", selection)).toBe("a.py:2 (before)\n```python\nb\n```\n");
    expect(formatReference("a.py", selection, "main")).toBe(
      "a.py:2 (before, main)\n```python\nb\n```\n",
    );
  });

  it("uses a plain fence for files without a known extension", () => {
    expect(formatReference("Notes", { side: "after", lines: [{ number: 1, text: "x" }] })).toBe(
      "Notes:1 (after)\n```\nx\n```\n",
    );
  });

  it("lengthens the fence when the snippet contains one", () => {
    const lines = [
      { number: 1, text: "```ts" },
      { number: 2, text: "```" },
    ];
    expect(formatReference("README.md", { side: "after", lines })).toBe(
      "README.md:1-2 (after)\n````md\n```ts\n```\n````\n",
    );
  });
});

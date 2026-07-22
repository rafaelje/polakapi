import { describe, expect, it } from "vitest";

import { resolveDirectionalFocus, type PaneBox } from "./terminal-focus-navigation";

function box(id: string, left: number, top: number, right: number, bottom: number): PaneBox {
  return { id, left, top, right, bottom };
}

const GRID: PaneBox[] = [
  box("a", 0, 0, 100, 100),
  box("b", 104, 0, 200, 100),
  box("c", 0, 104, 100, 200),
  box("d", 104, 104, 200, 200),
];

describe("resolveDirectionalFocus", () => {
  it("moves across each direction in a 2x2 grid", () => {
    expect(resolveDirectionalFocus(GRID, "a", "right")).toBe("b");
    expect(resolveDirectionalFocus(GRID, "b", "left")).toBe("a");
    expect(resolveDirectionalFocus(GRID, "a", "down")).toBe("c");
    expect(resolveDirectionalFocus(GRID, "c", "up")).toBe("a");
    expect(resolveDirectionalFocus(GRID, "d", "left")).toBe("c");
    expect(resolveDirectionalFocus(GRID, "d", "up")).toBe("b");
  });

  it("returns null when no pane lies in that direction", () => {
    expect(resolveDirectionalFocus(GRID, "a", "left")).toBeNull();
    expect(resolveDirectionalFocus(GRID, "a", "up")).toBeNull();
    expect(resolveDirectionalFocus(GRID, "d", "right")).toBeNull();
    expect(resolveDirectionalFocus(GRID, "d", "down")).toBeNull();
  });

  it("prefers the perpendicular-overlapping pane over a nearer diagonal one", () => {
    const layout = [
      box("tall", 0, 0, 100, 200),
      box("top", 104, 0, 200, 98),
      box("bottom", 104, 102, 200, 200),
    ];
    expect(resolveDirectionalFocus(layout, "bottom", "left")).toBe("tall");
    expect(resolveDirectionalFocus(layout, "tall", "right")).toBe("top");
  });

  it("picks the nearest edge when several panes overlap in the direction", () => {
    const row = [box("a", 0, 0, 60, 100), box("b", 64, 0, 120, 100), box("c", 124, 0, 200, 100)];
    expect(resolveDirectionalFocus(row, "c", "left")).toBe("b");
    expect(resolveDirectionalFocus(row, "a", "right")).toBe("b");
  });

  it("breaks edge ties by perpendicular center distance", () => {
    const layout = [
      box("focused", 0, 100, 100, 200),
      box("top", 104, 0, 200, 95),
      box("middle", 104, 100, 200, 200),
      box("bottom", 104, 205, 200, 300),
    ];
    expect(resolveDirectionalFocus(layout, "focused", "right")).toBe("middle");
  });

  it("falls back to the first pane when nothing is focused", () => {
    expect(resolveDirectionalFocus(GRID, null, "right")).toBe("a");
    expect(resolveDirectionalFocus(GRID, "ghost", "right")).toBe("a");
  });

  it("returns null for an empty pane list", () => {
    expect(resolveDirectionalFocus([], null, "left")).toBeNull();
  });
});

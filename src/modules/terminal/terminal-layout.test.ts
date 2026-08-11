import { describe, expect, it } from "vitest";

import {
  appendTerminalPane,
  createDefaultTerminalLayout,
  dockTerminalPane,
  dockTerminalPaneAtRoot,
  removeTerminalPane,
  repairTerminalLayout,
  replaceTerminalPaneId,
  terminalLayoutPaneIds,
  updateTerminalSplitRatio,
} from "./terminal-layout";

describe("terminal layout transforms", () => {
  it("creates a two-column row-major default layout", () => {
    const layout = createDefaultTerminalLayout(["a", "b", "c"]);

    expect(layout).toMatchObject({
      type: "split",
      axis: "column",
      first: { type: "split", axis: "row" },
      second: { type: "pane", paneId: "c" },
    });
    expect(terminalLayoutPaneIds(layout)).toEqual(["a", "b", "c"]);
  });

  it("appends a new pane to the right of the focused target", () => {
    const initial = createDefaultTerminalLayout(["a", "b"]);
    const layout = appendTerminalPane(initial, "c", "a");

    expect(layout).toMatchObject({
      type: "split",
      first: {
        type: "split",
        axis: "row",
        first: { paneId: "a" },
        second: { paneId: "c" },
      },
      second: { paneId: "b" },
    });
  });

  it("docks one pane below another and removes its previous leaf", () => {
    const initial = createDefaultTerminalLayout(["a", "b", "c"]);
    const layout = dockTerminalPane(initial, "a", "c", "bottom");

    expect(layout).toMatchObject({
      type: "split",
      axis: "column",
      second: {
        type: "split",
        axis: "column",
        first: { paneId: "c" },
        second: { paneId: "a" },
      },
    });
    expect(terminalLayoutPaneIds(layout)).toEqual(["b", "c", "a"]);
  });

  it("leaves the layout unchanged for invalid docking operations", () => {
    const initial = createDefaultTerminalLayout(["a", "b"]);

    expect(dockTerminalPane(initial, "a", "a", "left")).toBe(initial);
    expect(dockTerminalPane(initial, "missing", "b", "left")).toBe(initial);
    expect(dockTerminalPane(initial, "a", "missing", "left")).toBe(initial);
  });

  it("moves a pane to each root edge", () => {
    const initial = createDefaultTerminalLayout(["a", "b", "c"]);

    expect(dockTerminalPaneAtRoot(initial, "b", "top")).toMatchObject({
      axis: "column",
      first: { paneId: "b" },
    });
    expect(dockTerminalPaneAtRoot(initial, "b", "right")).toMatchObject({
      axis: "row",
      second: { paneId: "b" },
    });
  });

  it("collapses empty split branches when panes are removed", () => {
    const initial = createDefaultTerminalLayout(["a", "b"]);

    expect(removeTerminalPane(initial, "a")).toEqual({ type: "pane", paneId: "b" });
    expect(removeTerminalPane(removeTerminalPane(initial, "a"), "b")).toBeNull();
  });

  it("replaces a respawned pane identifier in place", () => {
    const initial = createDefaultTerminalLayout(["a", "b"]);
    const layout = replaceTerminalPaneId(initial, "a", "next-a");

    expect(terminalLayoutPaneIds(layout)).toEqual(["next-a", "b"]);
    expect(layout).toMatchObject({ first: { paneId: "next-a" } });
  });

  it("updates a nested ratio and clamps unsafe values", () => {
    const initial = createDefaultTerminalLayout(["a", "b", "c"]);
    const nested = updateTerminalSplitRatio(initial, ["first"], 0.95);

    expect(nested).toMatchObject({ first: { ratio: 0.9 } });
    expect(updateTerminalSplitRatio(nested, [], Number.NaN)).toMatchObject({ ratio: 0.5 });
  });
});

describe("repairTerminalLayout", () => {
  it("remaps regenerated identifiers while retaining split metadata", () => {
    const persisted = {
      type: "split",
      axis: "column",
      ratio: 0.7,
      first: { type: "pane", paneId: "old-a" },
      second: { type: "pane", paneId: "old-b" },
    };
    const idMap = new Map([
      ["old-a", "new-a"],
      ["old-b", "new-b"],
    ]);

    expect(repairTerminalLayout(persisted, ["new-a", "new-b"], idMap)).toEqual({
      type: "split",
      axis: "column",
      ratio: 0.7,
      first: { type: "pane", paneId: "new-a" },
      second: { type: "pane", paneId: "new-b" },
    });
  });

  it("removes missing and duplicate leaves then appends every live pane once", () => {
    const invalid = {
      type: "split",
      axis: "row",
      ratio: 4,
      first: { type: "pane", paneId: "a" },
      second: {
        type: "split",
        axis: "row",
        ratio: 0.5,
        first: { type: "pane", paneId: "a" },
        second: { type: "pane", paneId: "missing" },
      },
    };

    const repaired = repairTerminalLayout(invalid, ["a", "b", "c"]);

    expect(terminalLayoutPaneIds(repaired)).toEqual(["a", "b", "c"]);
    expect(new Set(terminalLayoutPaneIds(repaired)).size).toBe(3);
  });

  it("builds a valid layout when persisted data is unusable", () => {
    const repaired = repairTerminalLayout({ nope: true }, ["a", "b"]);

    expect(terminalLayoutPaneIds(repaired)).toEqual(["a", "b"]);
  });
});

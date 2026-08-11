import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalLayoutNode } from "./terminal-layout";
import { layoutTerminalSplits } from "./terminal-split-layout";
import type { TerminalPane } from "./terminal-pane";

function fakePane(id: string): TerminalPane {
  const el = document.createElement("div");
  el.className = "pane";
  el.dataset.ptyId = id;
  return { el } as unknown as TerminalPane;
}

describe("layoutTerminalSplits", () => {
  const originalAnimationFrame = globalThis.requestAnimationFrame;

  beforeEach(() => {
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalAnimationFrame;
    document.body.innerHTML = "";
  });

  it("renders nested row and column splits with matching gutters", () => {
    const grid = document.createElement("div");
    const panes = new Map([
      ["a", fakePane("a")],
      ["b", fakePane("b")],
      ["c", fakePane("c")],
    ]);
    const layout: TerminalLayoutNode = {
      type: "split",
      axis: "column",
      ratio: 0.6,
      first: {
        type: "split",
        axis: "row",
        ratio: 0.4,
        first: { type: "pane", paneId: "a" },
        second: { type: "pane", paneId: "b" },
      },
      second: { type: "pane", paneId: "c" },
    };

    layoutTerminalSplits(grid, layout, panes, { refit: vi.fn(), onRatioChange: vi.fn() });

    expect(grid.querySelectorAll(".terminal-split--row")).toHaveLength(1);
    expect(grid.querySelectorAll(".terminal-split--column")).toHaveLength(1);
    expect(grid.querySelectorAll(".gutter-h")).toHaveLength(1);
    expect(grid.querySelectorAll(".gutter-v")).toHaveLength(1);
    expect(
      [...grid.querySelectorAll<HTMLElement>(".pane")].map((pane) => pane.dataset.ptyId),
    ).toEqual(["a", "b", "c"]);
  });

  it("reparents the original pane elements without replacing them", () => {
    const grid = document.createElement("div");
    const paneA = fakePane("a");
    const paneB = fakePane("b");
    grid.append(paneA.el, paneB.el);
    const panes = new Map([
      ["a", paneA],
      ["b", paneB],
    ]);
    const layout: TerminalLayoutNode = {
      type: "split",
      axis: "row",
      ratio: 0.25,
      first: { type: "pane", paneId: "a" },
      second: { type: "pane", paneId: "b" },
    };

    layoutTerminalSplits(grid, layout, panes, { refit: vi.fn(), onRatioChange: vi.fn() });

    expect(grid.querySelector('[data-pty-id="a"]')).toBe(paneA.el);
    expect(grid.querySelector('[data-pty-id="b"]')).toBe(paneB.el);
    expect(paneA.el.style.flex).toBe("0.25 1 0px");
    expect(paneB.el.style.flex).toBe("0.75 1 0px");
  });

  it("reports the committed ratio for the correct nested split", () => {
    const grid = document.createElement("div");
    const paneA = fakePane("a");
    const paneB = fakePane("b");
    const panes = new Map([
      ["a", paneA],
      ["b", paneB],
    ]);
    const onRatioChange = vi.fn();
    const layout: TerminalLayoutNode = {
      type: "split",
      axis: "row",
      ratio: 0.5,
      first: { type: "pane", paneId: "a" },
      second: { type: "pane", paneId: "b" },
    };
    Object.defineProperty(paneA.el, "getBoundingClientRect", {
      value: () => ({ width: 200, height: 100 }),
    });
    Object.defineProperty(paneB.el, "getBoundingClientRect", {
      value: () => ({ width: 200, height: 100 }),
    });

    layoutTerminalSplits(grid, layout, panes, { refit: vi.fn(), onRatioChange });
    const gutter = grid.querySelector<HTMLElement>(".gutter-h");
    if (!gutter) throw new Error("expected gutter");
    gutter.dispatchEvent(new MouseEvent("mousedown", { clientX: 200, bubbles: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 300 }));
    window.dispatchEvent(new MouseEvent("mouseup"));

    expect(onRatioChange).toHaveBeenCalledExactlyOnceWith([], 0.75);
  });
});

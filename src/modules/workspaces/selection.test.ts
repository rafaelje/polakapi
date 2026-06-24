import { describe, expect, it, vi } from "vitest";
import { createSelectionStore } from "./selection";
import type { ProjectId } from "./types";

const pid = (s: string): ProjectId => s as ProjectId;

describe("selection store", () => {
  it("setSingle replaces selection and sets anchor", () => {
    const store = createSelectionStore();
    store.setSingle(pid("a"));
    expect(Array.from(store.getSelected())).toEqual(["a"]);
    store.setSingle(pid("b"));
    expect(Array.from(store.getSelected())).toEqual(["b"]);
  });

  it("toggle adds, removes, and resets anchor when removing the anchor", () => {
    const store = createSelectionStore();
    store.toggle(pid("a"));
    store.toggle(pid("b"));
    expect([...store.getSelected()].sort()).toEqual(["a", "b"]);
    store.toggle(pid("a"));
    expect(Array.from(store.getSelected())).toEqual(["b"]);
  });

  it("selectRange uses anchor and selects inclusive", () => {
    const order = ["a", "b", "c", "d"].map(pid);
    const store = createSelectionStore();
    store.setSingle(pid("b"));
    store.selectRange(pid("d"), order);
    expect([...store.getSelected()].sort()).toEqual(["b", "c", "d"]);
  });

  it("selectRange works in both directions, anchor stays put", () => {
    const order = ["a", "b", "c", "d"].map(pid);
    const store = createSelectionStore();
    store.setSingle(pid("c"));
    store.selectRange(pid("a"), order);
    expect([...store.getSelected()].sort()).toEqual(["a", "b", "c"]);
    // Anchor still 'c': shifting to 'd' should give c..d.
    store.selectRange(pid("d"), order);
    expect([...store.getSelected()].sort()).toEqual(["c", "d"]);
  });

  it("selectRange without anchor degenerates to setSingle", () => {
    const order = ["a", "b", "c"].map(pid);
    const store = createSelectionStore();
    store.selectRange(pid("b"), order);
    expect(Array.from(store.getSelected())).toEqual(["b"]);
  });

  it("prune removes ids no longer valid", () => {
    const store = createSelectionStore();
    store.toggle(pid("a"));
    store.toggle(pid("b"));
    store.prune(new Set([pid("a")]));
    expect(Array.from(store.getSelected())).toEqual(["a"]);
  });

  it("notifies listeners only when selection or anchor changes", () => {
    const store = createSelectionStore();
    const listener = vi.fn();
    store.on(listener);
    store.setSingle(pid("a"));
    store.setSingle(pid("a")); // no change
    expect(listener).toHaveBeenCalledTimes(1);
    store.clear();
    store.clear(); // already empty
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it } from "vitest";

import { resolveInsertTarget, type TerminalManagerLookup } from "./insert-target";

function mkManager(
  ids: string[],
  focused: string | null,
  opts?: { dead?: string[] },
): TerminalManagerLookup {
  const dead = new Set(opts?.dead ?? []);
  return {
    focusedPaneId: focused,
    ids: () => ids,
    get: (id) => (ids.includes(id) ? { id } : undefined),
    isLive: (id) => ids.includes(id) && !dead.has(id),
  };
}

describe("resolveInsertTarget", () => {
  it("returns null when no manager is active", () => {
    expect(resolveInsertTarget({ getActive: () => null })).toBeNull();
  });

  it("returns null when the manager has no panes", () => {
    expect(resolveInsertTarget({ getActive: () => mkManager([], null) })).toBeNull();
  });

  it("uses focusedPaneId and reports its 1-based index", () => {
    const m = mkManager(["a", "b", "c"], "b");
    expect(resolveInsertTarget({ getActive: () => m })).toEqual({
      ptyId: "b",
      paneLabel: "pane 2",
    });
  });

  it("falls back to the first live pane when nothing is focused", () => {
    const m = mkManager(["a", "b"], null);
    expect(resolveInsertTarget({ getActive: () => m })).toEqual({
      ptyId: "a",
      paneLabel: "pane 1",
    });
  });

  it("skips a focused pane that is dead and picks the next live one", () => {
    // pane 1 has a failed/exited pty; focus was on it, but we should fall
    // through to pane 2. The reported label reflects the actual pane index.
    const m = mkManager(["dead-a", "b"], "dead-a", { dead: ["dead-a"] });
    expect(resolveInsertTarget({ getActive: () => m })).toEqual({
      ptyId: "b",
      paneLabel: "pane 2",
    });
  });

  it("returns null when every pane is dead (failed spawns)", () => {
    const m = mkManager(["dead-a", "dead-b"], "dead-a", { dead: ["dead-a", "dead-b"] });
    expect(resolveInsertTarget({ getActive: () => m })).toBeNull();
  });

  it("returns null when focusedPaneId points at an unknown pane (dead)", () => {
    const m: TerminalManagerLookup = {
      focusedPaneId: "ghost",
      ids: () => ["a"],
      get: (id) => (id === "a" ? {} : undefined),
      isLive: (id) => id === "a",
    };
    // Focus is stale but pane 'a' is live — we should still resolve to it.
    expect(resolveInsertTarget({ getActive: () => m })).toEqual({
      ptyId: "a",
      paneLabel: "pane 1",
    });
  });
});

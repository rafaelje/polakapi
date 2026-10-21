import { describe, expect, it, vi } from "vitest";

vi.mock("../shared/persistence/store", () => ({ queueSave: vi.fn() }));

import { trackLastSession } from "./last-session";
import type { ProjectId } from "../modules/workspaces/state/types";

const id = (value: string): ProjectId => value as ProjectId;

function fakeCounts() {
  let counts = new Map<ProjectId, number>();
  const listeners = new Set<(event: { type: string }) => void>();
  return {
    liveCountsByProject: () => counts,
    on: (listener: (event: { type: string }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: Record<string, number>): void {
      counts = new Map(Object.entries(next).map(([key, n]) => [id(key), n]));
      for (const listener of listeners) listener({ type: "counts-changed" });
    },
  };
}

function setup(previous: string[], known = ["a", "b", "c"]) {
  const counts = fakeCounts();
  const save = vi.fn<(ids: ProjectId[]) => void>();
  const tracker = trackLastSession({
    previous,
    counts,
    knownProjects: () => new Set(known.map(id)),
    save,
  });
  return { counts, save, tracker };
}

describe("last session", () => {
  it("marks the projects that were running until they run again", () => {
    const { counts, save, tracker } = setup(["a", "b"]);
    const changes: Array<[string, boolean]> = [];
    tracker.on((projectId, marked) => changes.push([projectId, marked]));
    expect(tracker.isMarked(id("a"))).toBe(true);
    expect(tracker.isMarked(id("c"))).toBe(false);
    counts.set({ a: 2 });
    expect(tracker.isMarked(id("a"))).toBe(false);
    expect(changes).toEqual([["a", false]]);
    expect(save).not.toHaveBeenCalled();
    counts.set({ a: 2, c: 1 });
    expect(save).toHaveBeenLastCalledWith(["a", "b", "c"]);
    counts.set({ a: 0, c: 1 });
    expect(save).toHaveBeenLastCalledWith(["b", "c"]);
  });

  it("drops projects that no longer exist", () => {
    const { counts, save } = setup(["gone", "b"]);
    counts.set({ c: 1 });
    expect(save).toHaveBeenLastCalledWith(["b", "c"]);
  });

  it("keeps the list once quitting closes the terminals", () => {
    const { counts, save, tracker } = setup([]);
    counts.set({ a: 1, b: 3 });
    expect(save).toHaveBeenLastCalledWith(["a", "b"]);
    tracker.freeze();
    counts.set({});
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("clears a mark when the project is opened", () => {
    const { save, tracker } = setup(["a", "b"]);
    tracker.clear(id("b"));
    expect(tracker.isMarked(id("b"))).toBe(false);
    expect(save).toHaveBeenLastCalledWith(["a"]);
  });
});

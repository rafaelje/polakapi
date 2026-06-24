import type { ProjectId } from "./types";

// Transient multi-selection of project rows in the workspaces panel.
//
// Drives the `.selected` visual on rows and the multi-source dragstart in
// drag-drop.ts. Not persisted: lives only for the panel's lifetime.

export type SelectionListener = (selected: ReadonlySet<ProjectId>) => void;

export interface SelectionStore {
  getSelected(): ReadonlySet<ProjectId>;
  has(id: ProjectId): boolean;
  /** Replace selection with a single id, and reset the range anchor. */
  setSingle(id: ProjectId): void;
  /**
   * Toggle membership of `id`. When the id becomes selected it also becomes
   * the new range anchor for subsequent shift+click range selects.
   */
  toggle(id: ProjectId): void;
  /**
   * Select every id in `orderedIds` between the current anchor and `toId`
   * (inclusive). When no anchor is set, falls back to `setSingle(toId)`.
   * `orderedIds` is the panel-rendered order of the workspace containing
   * the row clicked — the caller reads it from the DOM at click time.
   */
  selectRange(toId: ProjectId, orderedIds: readonly ProjectId[]): void;
  clear(): void;
  /** Drop ids not in `valid`. Called on state changes to garbage-collect. */
  prune(valid: ReadonlySet<ProjectId>): void;
  on(listener: SelectionListener): () => void;
}

export function createSelectionStore(): SelectionStore {
  let selected = new Set<ProjectId>();
  let anchor: ProjectId | null = null;
  const listeners = new Set<SelectionListener>();

  const emit = (): void => {
    const snapshot: ReadonlySet<ProjectId> = new Set(selected);
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("SelectionStore listener threw", error);
      }
    }
  };

  const setSelectedTo = (next: Set<ProjectId>, nextAnchor: ProjectId | null): boolean => {
    if (sameSet(selected, next) && anchor === nextAnchor) return false;
    selected = next;
    anchor = nextAnchor;
    return true;
  };

  return {
    getSelected: () => selected,
    has: (id) => selected.has(id),
    setSingle: (id) => {
      if (setSelectedTo(new Set([id]), id)) emit();
    },
    toggle: (id) => {
      const next = new Set(selected);
      let nextAnchor = anchor;
      if (next.has(id)) {
        next.delete(id);
        if (anchor === id) nextAnchor = null;
      } else {
        next.add(id);
        nextAnchor = id;
      }
      if (setSelectedTo(next, nextAnchor)) emit();
    },
    selectRange: (toId, orderedIds) => {
      if (anchor === null || !orderedIds.includes(anchor)) {
        if (setSelectedTo(new Set([toId]), toId)) emit();
        return;
      }
      const fromIdx = orderedIds.indexOf(anchor);
      const toIdx = orderedIds.indexOf(toId);
      if (toIdx < 0) return;
      const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
      const next = new Set<ProjectId>();
      for (let i = lo; i <= hi; i++) next.add(orderedIds[i]);
      // Anchor stays put so successive shift+clicks pivot around the same row.
      if (setSelectedTo(next, anchor)) emit();
    },
    clear: () => {
      if (selected.size === 0 && anchor === null) return;
      selected = new Set();
      anchor = null;
      emit();
    },
    prune: (valid) => {
      if (selected.size === 0 && anchor === null) return;
      const next = new Set<ProjectId>();
      for (const id of selected) if (valid.has(id)) next.add(id);
      const nextAnchor = anchor && valid.has(anchor) ? anchor : null;
      if (setSelectedTo(next, nextAnchor)) emit();
    },
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

import { queueSave } from "../shared/persistence/store";
import type { LastSessionSource } from "../modules/workspaces/panel/workspaces-panel";
import type { ProjectId } from "../modules/workspaces/state/types";

// Projects that had live terminals when polakapi last closed are marked in the
// sidebar until they run again. The list is saved as terminals open and close
// rather than only on quit, so a crash or a forced kill still leaves it behind.

export interface LastSessionCounts {
  liveCountsByProject(): ReadonlyMap<ProjectId, number>;
  on(listener: (event: { type: string }) => void): () => void;
}

export interface LastSessionHandle extends LastSessionSource {
  /** Stops saving; quitting closes every terminal and must not record that. */
  freeze(): void;
  /** Drops the mark, e.g. once the user opens the project. */
  clear(projectId: ProjectId): void;
  dispose(): void;
}

export interface LastSessionOptions {
  previous: readonly string[] | undefined;
  counts: LastSessionCounts;
  /** Ids of projects that still exist, so deleted ones fall out of the list. */
  knownProjects: () => ReadonlySet<ProjectId>;
  save?: (ids: ProjectId[]) => void;
}

export function trackLastSession(opts: LastSessionOptions): LastSessionHandle {
  // Ids come from layout.json; ones that no longer exist are dropped on save.
  const marked = new Set((opts.previous ?? []) as readonly ProjectId[]);
  const listeners = new Set<(projectId: ProjectId, marked: boolean) => void>();
  const save = opts.save ?? ((ids) => queueSave({ lastRunningProjectIds: ids }));
  let frozen = false;
  let last = "";

  const notify = (projectId: ProjectId, isMarked: boolean): void => {
    for (const listener of listeners) {
      try {
        listener(projectId, isMarked);
      } catch (error) {
        console.error("last session listener threw", error);
      }
    }
  };

  const unmark = (projectId: ProjectId): void => {
    if (marked.delete(projectId)) notify(projectId, false);
  };

  const persist = (): void => {
    if (frozen) return;
    const known = opts.knownProjects();
    const ids = new Set<ProjectId>();
    for (const [projectId, count] of opts.counts.liveCountsByProject()) {
      if (count > 0 && known.has(projectId)) ids.add(projectId);
    }
    for (const projectId of marked) if (known.has(projectId)) ids.add(projectId);
    const next = [...ids].sort();
    const key = next.join("\n");
    if (key === last) return;
    last = key;
    save(next);
  };

  const sync = (): void => {
    for (const [projectId, count] of opts.counts.liveCountsByProject()) {
      if (count > 0) unmark(projectId);
    }
    persist();
  };

  const unsubscribe = opts.counts.on((event) => {
    if (event.type === "counts-changed") sync();
  });
  last = [...marked].sort().join("\n");

  return {
    isMarked: (projectId) => marked.has(projectId),
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    freeze: () => {
      persist();
      frozen = true;
    },
    clear: (projectId) => {
      unmark(projectId);
      persist();
    },
    dispose: () => {
      frozen = true;
      unsubscribe();
      listeners.clear();
    },
  };
}

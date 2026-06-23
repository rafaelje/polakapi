import type { ProjectId, TerminalSpec, WorkspacesState } from "./types";
import { mapProjectInWorkspace, mapWorkspaces } from "./workspaces-reducer-helpers";

// ---------------------------------------------------------------------------
// F2: per-project terminal specs.
// All helpers are no-ops (identity-preserving) when the project is missing or
// when the requested mutation would not change anything. Split out of
// `workspaces-reducer.ts` to keep each reducer file focused on one concern.
// ---------------------------------------------------------------------------

/** Append a terminal spec to the project's `terminals` array. */
export function addTerminalSpec(
  state: WorkspacesState,
  projectId: ProjectId,
  spec: TerminalSpec,
): WorkspacesState {
  return mapWorkspaces(state, (w) =>
    mapProjectInWorkspace(w, projectId, (p) => ({
      ...p,
      terminals: [...(p.terminals ?? []), spec],
    })),
  );
}

/** Remove the spec with `terminalId` from the project's `terminals` array. */
export function removeTerminalSpec(
  state: WorkspacesState,
  projectId: ProjectId,
  terminalId: string,
): WorkspacesState {
  return mapWorkspaces(state, (w) =>
    mapProjectInWorkspace(w, projectId, (p) => {
      const list = p.terminals;
      if (!list || list.length === 0) return p;
      const next = list.filter((t) => t.id !== terminalId);
      if (next.length === list.length) return p;
      return { ...p, terminals: next };
    }),
  );
}

/**
 * Apply a partial patch to a single terminal spec. The spec's `id` is never
 * patched. Returns the original state object when the patch would not change
 * any field (identity preservation, useful for downstream === comparisons).
 */
export function updateTerminalSpec(
  state: WorkspacesState,
  projectId: ProjectId,
  terminalId: string,
  patch: Partial<Omit<TerminalSpec, "id">>,
): WorkspacesState {
  return mapWorkspaces(state, (w) =>
    mapProjectInWorkspace(w, projectId, (p) => {
      const list = p.terminals;
      if (!list || list.length === 0) return p;
      let changed = false;
      const next = list.map((t) => {
        if (t.id !== terminalId) return t;
        const merged: TerminalSpec = { ...t, ...patch, id: t.id };
        if (shallowEqualSpec(t, merged)) return t;
        changed = true;
        return merged;
      });
      return changed ? { ...p, terminals: next } : p;
    }),
  );
}

/**
 * Replace the entire `terminals` array for a project. Used by the router
 * during full-restore writes so we get one persistence write instead of N.
 */
export function replaceTerminalSpecs(
  state: WorkspacesState,
  projectId: ProjectId,
  specs: TerminalSpec[],
): WorkspacesState {
  return mapWorkspaces(state, (w) =>
    mapProjectInWorkspace(w, projectId, (p) => ({ ...p, terminals: specs })),
  );
}

function shallowEqualSpec(a: TerminalSpec, b: TerminalSpec): boolean {
  return a.id === b.id && a.title === b.title && a.cwd === b.cwd && a.startupCmd === b.startupCmd;
}

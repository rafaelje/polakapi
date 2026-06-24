import type { Project, ProjectId, Workspace, WorkspacesState } from "./types";

// ---------------------------------------------------------------------------
// F3: per-project notes body.
// Pure reducer helper, single concern (no I/O, no class). Mirrors the
// structure of workspaces-reducer-terminals.ts so workspaces-reducer.ts can
// stay focused on workspace/project CRUD.
// ---------------------------------------------------------------------------

/**
 * Sets the `notes` field on a single project. Identity-preserving:
 *  - returns === state when the project does not exist
 *  - returns === state when the current value already equals `notes`
 *
 * `undefined` and `''` are treated as equivalent for the equality check so an
 * empty project does not get a redundant write the first time the user focuses
 * it.
 *
 * Implemented without `mapWorkspaces` so we can short-circuit at the state
 * level (the shared helper always spreads into a new state object). That
 * matters because the controller's `commit()` uses `next === this.state` as a
 * cheap dirty check before queuing a save.
 */
export function setProjectNotes(
  state: WorkspacesState,
  projectId: ProjectId,
  notes: string,
): WorkspacesState {
  let touched = false;
  const nextWorkspaces: Workspace[] = state.workspaces.map((workspace) => {
    let projectChanged = false;
    const projects: Project[] = workspace.projects.map((p) => {
      if (p.id !== projectId) return p;
      const current = p.notes ?? "";
      if (current === notes) return p;
      projectChanged = true;
      return { ...p, notes };
    });
    if (!projectChanged) return workspace;
    touched = true;
    return { ...workspace, projects };
  });
  if (!touched) return state;
  return { ...state, workspaces: nextWorkspaces };
}

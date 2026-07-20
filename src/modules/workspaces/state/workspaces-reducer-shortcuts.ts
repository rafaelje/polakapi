import type { Project, ProjectId, Workspace, WorkspaceId, WorkspacesState } from "./types";

// ---------------------------------------------------------------------------
// Activation shortcuts: a single character per project/workspace, bound to
// Ctrl+Alt+<key>. Pure reducer helpers, mirroring workspaces-reducer-notes.ts.
// ---------------------------------------------------------------------------

/** Normalizes user input to the stored form; null when it is not bindable. */
export function normalizeShortcutKey(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  return /^[a-z0-9]$/.test(key) ? key : null;
}

export type ShortcutTarget =
  | { kind: "project"; projectId: ProjectId }
  | { kind: "workspace"; workspaceId: WorkspaceId };

/** Resolves which item a pressed key activates. Projects win over workspaces. */
export function findShortcutTarget(state: WorkspacesState, key: string): ShortcutTarget | null {
  for (const workspace of state.workspaces) {
    for (const project of workspace.projects) {
      if (project.shortcut === key) return { kind: "project", projectId: project.id };
    }
  }
  for (const workspace of state.workspaces) {
    if (workspace.shortcut === key) return { kind: "workspace", workspaceId: workspace.id };
  }
  return null;
}

/**
 * Assigns (or clears, with undefined) a project's shortcut. The key is
 * unique app-wide: any other project or workspace holding it is silently
 * unassigned. Identity-preserving when nothing changes.
 */
export function setProjectShortcut(
  state: WorkspacesState,
  projectId: ProjectId,
  shortcut: string | undefined,
): WorkspacesState {
  return applyShortcut(state, shortcut, (p) => p.id === projectId, undefined);
}

/** Workspace counterpart of setProjectShortcut — same uniqueness contract. */
export function setWorkspaceShortcut(
  state: WorkspacesState,
  workspaceId: WorkspaceId,
  shortcut: string | undefined,
): WorkspacesState {
  return applyShortcut(state, shortcut, undefined, (w) => w.id === workspaceId);
}

function applyShortcut(
  state: WorkspacesState,
  shortcut: string | undefined,
  isTargetProject: ((p: Project) => boolean) | undefined,
  isTargetWorkspace: ((w: Workspace) => boolean) | undefined,
): WorkspacesState {
  let touched = false;
  const nextWorkspaces = state.workspaces.map((workspace) => {
    let wsChanged = false;
    const projects = workspace.projects.map((project) => {
      const next = nextShortcutFor(project.shortcut, shortcut, isTargetProject?.(project) ?? false);
      if (next === project.shortcut) return project;
      wsChanged = true;
      return { ...project, shortcut: next };
    });
    const wsShortcut = nextShortcutFor(
      workspace.shortcut,
      shortcut,
      isTargetWorkspace?.(workspace) ?? false,
    );
    if (!wsChanged && wsShortcut === workspace.shortcut) return workspace;
    touched = true;
    return { ...workspace, projects, shortcut: wsShortcut };
  });
  if (!touched) return state;
  return { ...state, workspaces: nextWorkspaces };
}

function nextShortcutFor(
  current: string | undefined,
  assigned: string | undefined,
  isTarget: boolean,
): string | undefined {
  if (isTarget) return assigned;
  // Uniqueness: stealing the key clears it from the previous holder.
  if (assigned !== undefined && current === assigned) return undefined;
  return current;
}

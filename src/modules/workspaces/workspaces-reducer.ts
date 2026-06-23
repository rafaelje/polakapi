import type {
  CreateProjectInput,
  Project,
  ProjectId,
  Workspace,
  WorkspaceId,
  WorkspacesState,
} from "./types";
import {
  compareByOrderThenName,
  mapProjectInWorkspace,
  mapWorkspaces,
  newProjectId,
  newWorkspaceId,
  reassignOrder,
} from "./workspaces-reducer-helpers";

const SCHEMA_VERSION = 1 as const;

export function createEmptyState(): WorkspacesState {
  return {
    workspaces: [],
    activeProjectId: null,
    schemaVersion: SCHEMA_VERSION,
  };
}

export function sortedWorkspaces(state: WorkspacesState): Workspace[] {
  return [...state.workspaces].sort(compareByOrderThenName);
}

export function sortedProjects(workspace: Workspace): Project[] {
  return [...workspace.projects].sort(compareByOrderThenName);
}

export function findProject(
  state: WorkspacesState,
  id: ProjectId,
): { workspace: Workspace; project: Project } | null {
  for (const workspace of state.workspaces) {
    const project = workspace.projects.find((p) => p.id === id);
    if (project) return { workspace, project };
  }
  return null;
}

export function addWorkspace(state: WorkspacesState, name: string): WorkspacesState {
  const workspace: Workspace = { id: newWorkspaceId(), name, projects: [] };
  return { ...state, workspaces: [...state.workspaces, workspace] };
}

export function renameWorkspace(
  state: WorkspacesState,
  id: WorkspaceId,
  name: string,
): WorkspacesState {
  return mapWorkspaces(state, (w) => (w.id === id ? { ...w, name } : w));
}

export function deleteWorkspace(state: WorkspacesState, id: WorkspaceId): WorkspacesState {
  const target = state.workspaces.find((w) => w.id === id);
  if (!target) return state;
  const removedProjectIds = new Set<ProjectId>(target.projects.map((p) => p.id));
  return {
    ...state,
    workspaces: state.workspaces.filter((w) => w.id !== id),
    activeProjectId:
      state.activeProjectId && removedProjectIds.has(state.activeProjectId)
        ? null
        : state.activeProjectId,
  };
}

export function toggleCollapsed(state: WorkspacesState, id: WorkspaceId): WorkspacesState {
  return mapWorkspaces(state, (w) => (w.id === id ? { ...w, collapsed: !w.collapsed } : w));
}

export function addProject(state: WorkspacesState, input: CreateProjectInput): WorkspacesState {
  const project: Project = {
    id: newProjectId(),
    name: input.name,
    path: input.path,
    color: input.color,
  };
  return mapWorkspaces(state, (w) =>
    w.id === input.workspaceId ? { ...w, projects: [...w.projects, project] } : w,
  );
}

export function renameProject(
  state: WorkspacesState,
  id: ProjectId,
  name: string,
): WorkspacesState {
  return mapWorkspaces(state, (w) => mapProjectInWorkspace(w, id, (p) => ({ ...p, name })));
}

export function changeProjectPath(
  state: WorkspacesState,
  id: ProjectId,
  path: string,
): WorkspacesState {
  return mapWorkspaces(state, (w) =>
    mapProjectInWorkspace(w, id, (p) => ({ ...p, path, pathInvalid: false })),
  );
}

export function setProjectPathInvalid(
  state: WorkspacesState,
  id: ProjectId,
  invalid: boolean,
): WorkspacesState {
  return mapWorkspaces(state, (w) =>
    mapProjectInWorkspace(w, id, (p) =>
      p.pathInvalid === invalid ? p : { ...p, pathInvalid: invalid },
    ),
  );
}

export function deleteProject(state: WorkspacesState, id: ProjectId): WorkspacesState {
  return {
    ...state,
    workspaces: state.workspaces.map((w) => ({
      ...w,
      projects: w.projects.filter((p) => p.id !== id),
    })),
    activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
  };
}

export function duplicateProject(state: WorkspacesState, id: ProjectId): WorkspacesState {
  return mapWorkspaces(state, (w) => {
    const idx = w.projects.findIndex((p) => p.id === id);
    if (idx === -1) return w;
    const source = w.projects[idx];
    const copy: Project = {
      ...source,
      id: newProjectId(),
      name: `${source.name} (copy)`,
      order: undefined,
    };
    const projects = [...w.projects];
    projects.splice(idx + 1, 0, copy);
    return { ...w, projects };
  });
}

export function moveProject(
  state: WorkspacesState,
  id: ProjectId,
  toWorkspaceId: WorkspaceId,
  atIndex: number,
): WorkspacesState {
  const found = findProject(state, id);
  if (!found) return state;
  const moved: Project = { ...found.project, order: undefined };
  return mapWorkspaces(state, (w) => {
    if (w.id === found.workspace.id && w.id === toWorkspaceId) {
      const filtered = w.projects.filter((p) => p.id !== id);
      const clamped = Math.max(0, Math.min(atIndex, filtered.length));
      const next = [...filtered];
      next.splice(clamped, 0, moved);
      return { ...w, projects: reassignOrder(next) };
    }
    if (w.id === found.workspace.id) {
      return { ...w, projects: w.projects.filter((p) => p.id !== id) };
    }
    if (w.id === toWorkspaceId) {
      const clamped = Math.max(0, Math.min(atIndex, w.projects.length));
      const next = [...w.projects];
      next.splice(clamped, 0, moved);
      return { ...w, projects: reassignOrder(next) };
    }
    return w;
  });
}

export function reorderProjects(
  state: WorkspacesState,
  workspaceId: WorkspaceId,
  orderedIds: ProjectId[],
): WorkspacesState {
  return mapWorkspaces(state, (w) => {
    if (w.id !== workspaceId) return w;
    const byId = new Map(w.projects.map((p) => [p.id, p]));
    const next: Project[] = [];
    for (const pid of orderedIds) {
      const p = byId.get(pid);
      if (p) {
        next.push(p);
        byId.delete(pid);
      }
    }
    for (const remaining of byId.values()) next.push(remaining);
    return { ...w, projects: reassignOrder(next) };
  });
}

export function reorderWorkspaces(
  state: WorkspacesState,
  orderedIds: WorkspaceId[],
): WorkspacesState {
  const byId = new Map(state.workspaces.map((w) => [w.id, w]));
  const next: Workspace[] = [];
  for (const wid of orderedIds) {
    const w = byId.get(wid);
    if (w) {
      next.push(w);
      byId.delete(wid);
    }
  }
  for (const remaining of byId.values()) next.push(remaining);
  return { ...state, workspaces: reassignOrder(next) };
}

export function resetAlphabeticalOrder(
  state: WorkspacesState,
  workspaceId: WorkspaceId,
): WorkspacesState {
  return mapWorkspaces(state, (w) =>
    w.id === workspaceId
      ? { ...w, projects: w.projects.map((p) => ({ ...p, order: undefined })) }
      : w,
  );
}

export function setActiveProject(state: WorkspacesState, id: ProjectId | null): WorkspacesState {
  if (state.activeProjectId === id) return state;
  if (id !== null && !findProject(state, id)) return state;
  return { ...state, activeProjectId: id };
}

// F2 per-project terminal helpers live in their own module to keep this file
// focused on the workspace/project CRUD surface. Re-export them so callers can
// keep importing from "./workspaces-reducer".
export {
  addTerminalSpec,
  removeTerminalSpec,
  replaceTerminalSpecs,
  updateTerminalSpec,
} from "./workspaces-reducer-terminals";

// F3 per-project notes helper — same pattern as the terminals re-export above.
export { setProjectNotes } from "./workspaces-reducer-notes";

// F4 appearance (color) helpers — same re-export pattern so callers can
// keep importing from "./workspaces-reducer".
export {
  PALETTE,
  deriveFallbackColor,
  setProjectColor,
  setWorkspaceColor,
} from "./workspaces-reducer-appearance";

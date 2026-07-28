import type { FolderId, Folder, Project, ProjectId, WorkspaceId, WorkspacesState } from "./types";
import {
  compareByOrderThenName,
  mapProjectInWorkspace,
  mapWorkspaces,
  newFolderId,
  reassignOrderWhere,
} from "./workspaces-reducer-helpers";
// Deliberately not importing `findProject` from "./workspaces-reducer" to
// avoid a circular import (that module re-exports this one's functions).
function findProjectAcrossWorkspaces(
  state: WorkspacesState,
  id: ProjectId,
): { workspace: WorkspacesState["workspaces"][number]; project: Project } | null {
  for (const workspace of state.workspaces) {
    const project = workspace.projects.find((p) => p.id === id);
    if (project) return { workspace, project };
  }
  return null;
}

export function addFolder(
  state: WorkspacesState,
  workspaceId: WorkspaceId,
  name: string,
): WorkspacesState {
  const folder: Folder = { id: newFolderId(), name };
  return mapWorkspaces(state, (w) =>
    w.id === workspaceId ? { ...w, folders: [...(w.folders ?? []), folder] } : w,
  );
}

export function renameFolder(
  state: WorkspacesState,
  workspaceId: WorkspaceId,
  folderId: FolderId,
  name: string,
): WorkspacesState {
  return mapWorkspaces(state, (w) => {
    if (w.id !== workspaceId || !w.folders) return w;
    return { ...w, folders: w.folders.map((f) => (f.id === folderId ? { ...f, name } : f)) };
  });
}

/**
 * Removes the folder and ungroups its member projects (clears their
 * `folderId`) rather than deleting them — unlike deleting a workspace, a
 * project always has a valid "no folder" fallback here.
 */
export function deleteFolder(
  state: WorkspacesState,
  workspaceId: WorkspaceId,
  folderId: FolderId,
): WorkspacesState {
  return mapWorkspaces(state, (w) => {
    if (w.id !== workspaceId) return w;
    const folders = (w.folders ?? []).filter((f) => f.id !== folderId);
    const projects = w.projects.map((p) =>
      p.folderId === folderId ? { ...p, folderId: undefined } : p,
    );
    return { ...w, folders, projects };
  });
}

export function toggleFolderCollapsed(
  state: WorkspacesState,
  workspaceId: WorkspaceId,
  folderId: FolderId,
): WorkspacesState {
  return mapWorkspaces(state, (w) => {
    if (w.id !== workspaceId || !w.folders) return w;
    return {
      ...w,
      folders: w.folders.map((f) => (f.id === folderId ? { ...f, collapsed: !f.collapsed } : f)),
    };
  });
}

function moveFolderBy(
  state: WorkspacesState,
  workspaceId: WorkspaceId,
  folderId: FolderId,
  delta: 1 | -1,
): WorkspacesState {
  return mapWorkspaces(state, (w) => {
    if (w.id !== workspaceId) return w;
    const sorted = [...(w.folders ?? [])].sort(compareByOrderThenName);
    const idx = sorted.findIndex((f) => f.id === folderId);
    const swapIdx = idx + delta;
    if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return w;
    // Stamp every folder with its current sorted index first, so the swap is
    // meaningful even when some/all folders previously had no explicit order
    // (i.e. were sorting alphabetically).
    const stamped = sorted.map((f, i) => ({ ...f, order: i }));
    const a = stamped[idx];
    const b = stamped[swapIdx];
    stamped[idx] = { ...b, order: a.order };
    stamped[swapIdx] = { ...a, order: b.order };
    return { ...w, folders: stamped };
  });
}

export const moveFolderUp = (
  state: WorkspacesState,
  workspaceId: WorkspaceId,
  folderId: FolderId,
): WorkspacesState => moveFolderBy(state, workspaceId, folderId, -1);

export const moveFolderDown = (
  state: WorkspacesState,
  workspaceId: WorkspaceId,
  folderId: FolderId,
): WorkspacesState => moveFolderBy(state, workspaceId, folderId, 1);

/** Clears `order` on every project in one bucket (folder, or ungrouped when `folderId` is undefined). */
export function resetAlphabeticalOrderInFolder(
  state: WorkspacesState,
  workspaceId: WorkspaceId,
  folderId: FolderId | undefined,
): WorkspacesState {
  return mapWorkspaces(state, (w) => {
    if (w.id !== workspaceId) return w;
    return {
      ...w,
      projects: w.projects.map((p) =>
        (p.folderId ?? undefined) === folderId ? { ...p, order: undefined } : p,
      ),
    };
  });
}

/**
 * Row-menu entry point: assigns `projectId` to `folderId` (undefined =
 * workspace root), clearing its `order` so it falls back to alphabetical
 * position in the new bucket. Same-workspace only in v1 — folder ids are
 * workspace-scoped, so moving a project into a different workspace's folder
 * is handled by `moveProjectToBucket` instead.
 */
export function moveProjectToFolder(
  state: WorkspacesState,
  projectId: ProjectId,
  folderId: FolderId | undefined,
): WorkspacesState {
  return mapWorkspaces(state, (w) =>
    mapProjectInWorkspace(w, projectId, (p) => ({ ...p, folderId, order: undefined })),
  );
}

/**
 * Drag-and-drop entry point: moves one project to `(toWorkspaceId, folderId)`
 * at `atIndex` within that destination bucket only, leaving every other
 * bucket's projects and `order` values untouched. `folderId` undefined means
 * the workspace's ungrouped root.
 */
export function moveProjectToBucket(
  state: WorkspacesState,
  id: ProjectId,
  toWorkspaceId: WorkspaceId,
  folderId: FolderId | undefined,
  atIndex: number,
): WorkspacesState {
  return moveProjectsToBucket(state, [id], toWorkspaceId, folderId, atIndex);
}

/** Bulk counterpart of `moveProjectToBucket`, symmetric with `moveProjects`. */
export function moveProjectsToBucket(
  state: WorkspacesState,
  ids: readonly ProjectId[],
  toWorkspaceId: WorkspaceId,
  folderId: FolderId | undefined,
  atIndex: number,
): WorkspacesState {
  if (ids.length === 0) return state;
  const movingSet = new Set<ProjectId>(ids);
  const movingProjects: Project[] = [];
  for (const id of ids) {
    const found = findProjectAcrossWorkspaces(state, id);
    if (found) movingProjects.push({ ...found.project, order: undefined, folderId });
  }
  if (movingProjects.length === 0) return state;

  return mapWorkspaces(state, (w) => {
    if (w.id === toWorkspaceId) {
      const remaining = w.projects.filter((p) => !movingSet.has(p.id));
      const others = remaining.filter((p) => (p.folderId ?? undefined) !== folderId);
      const bucketMembers = remaining.filter((p) => (p.folderId ?? undefined) === folderId);
      const clamped = Math.max(0, Math.min(atIndex, bucketMembers.length));
      const nextBucket = [...bucketMembers];
      nextBucket.splice(clamped, 0, ...movingProjects);
      const merged = [...others, ...nextBucket];
      const restamped = reassignOrderWhere(merged, (p) => (p.folderId ?? undefined) === folderId);
      return { ...w, projects: restamped };
    }
    const hadAny = w.projects.some((p) => movingSet.has(p.id));
    if (!hadAny) return w;
    return { ...w, projects: w.projects.filter((p) => !movingSet.has(p.id)) };
  });
}

/**
 * Reorders projects within one bucket (folder, or ungrouped when `folderId`
 * is undefined) of one workspace, leaving other buckets' `order` untouched.
 */
export function reorderProjectsInFolder(
  state: WorkspacesState,
  workspaceId: WorkspaceId,
  folderId: FolderId | undefined,
  orderedIds: ProjectId[],
): WorkspacesState {
  return mapWorkspaces(state, (w) => {
    if (w.id !== workspaceId) return w;
    const positionById = new Map<ProjectId, number>();
    orderedIds.forEach((id, idx) => positionById.set(id, idx));
    let changed = false;
    const projects = w.projects.map((p) => {
      if ((p.folderId ?? undefined) !== folderId) return p;
      const idx = positionById.get(p.id);
      if (idx === undefined || p.order === idx) return p;
      changed = true;
      return { ...p, order: idx };
    });
    return changed ? { ...w, projects } : w;
  });
}

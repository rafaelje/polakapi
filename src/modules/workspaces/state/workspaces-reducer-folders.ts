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
  path?: string,
): WorkspacesState {
  const folder: Folder = { id: newFolderId(), name, path };
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

// Ungroups member projects (clears folderId) instead of deleting them.
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
    type Entry = { kind: "folder"; item: Folder } | { kind: "project"; item: Project };
    const sorted: Entry[] = [
      ...(w.folders ?? []).map((item): Entry => ({ kind: "folder", item })),
      ...w.projects
        .filter((item) => item.folderId === undefined)
        .map((item): Entry => ({ kind: "project", item })),
    ].sort((a, b) => compareByOrderThenName(a.item, b.item));
    const idx = sorted.findIndex((entry) => entry.kind === "folder" && entry.item.id === folderId);
    const swapIdx = idx + delta;
    if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return w;
    const moved = [...sorted];
    const [entry] = moved.splice(idx, 1);
    moved.splice(swapIdx, 0, entry);
    const folderOrders = new Map<FolderId, number>();
    const projectOrders = new Map<ProjectId, number>();
    moved.forEach((current, order) => {
      if (current.kind === "folder") folderOrders.set(current.item.id, order);
      else projectOrders.set(current.item.id, order);
    });
    return {
      ...w,
      folders: (w.folders ?? []).map((folder) => ({
        ...folder,
        order: folderOrders.get(folder.id),
      })),
      projects: w.projects.map((project) =>
        project.folderId === undefined
          ? { ...project, order: projectOrders.get(project.id) }
          : project,
      ),
    };
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

// Row-menu entry point; same-workspace only. Cross-workspace moves use moveProjectToBucket.
export function moveProjectToFolder(
  state: WorkspacesState,
  projectId: ProjectId,
  folderId: FolderId | undefined,
): WorkspacesState {
  return mapWorkspaces(state, (w) =>
    mapProjectInWorkspace(w, projectId, (p) => ({ ...p, folderId, order: undefined })),
  );
}

// Drag-and-drop entry point: moves one project into a bucket at atIndex.
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

// Reorders projects within one bucket, leaving other buckets' order untouched.
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

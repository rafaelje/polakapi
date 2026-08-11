import type {
  FolderId,
  Project,
  ProjectId,
  Workspace,
  WorkspaceId,
  WorkspacesState,
} from "./types";

function uuid(): string {
  return crypto.randomUUID();
}

export function newWorkspaceId(): WorkspaceId {
  return uuid() as WorkspaceId;
}

export function newProjectId(): ProjectId {
  return uuid() as ProjectId;
}

export function newFolderId(): FolderId {
  return uuid() as FolderId;
}

/**
 * Comparator used by `sortedWorkspaces` and `sortedProjects`. Items with an
 * explicit `order` always sort before items without one, then `localeCompare`
 * by name decides ties.
 */
export function compareByOrderThenName<T extends { name: string; order?: number }>(
  a: T,
  b: T,
): number {
  const ao = a.order;
  const bo = b.order;
  if (ao !== undefined && bo !== undefined) return ao - bo;
  if (ao !== undefined) return -1;
  if (bo !== undefined) return 1;
  return a.name.localeCompare(b.name);
}

/**
 * Apply `fn` to every workspace in `state` and return a new state object.
 * Identity-preserving: workspaces returned unchanged by `fn` are reused.
 */
export function mapWorkspaces(
  state: WorkspacesState,
  fn: (w: Workspace) => Workspace,
): WorkspacesState {
  return { ...state, workspaces: state.workspaces.map(fn) };
}

/**
 * Apply `fn` to the project with `id` inside `workspace`, returning a new
 * workspace if it changed, or the original reference if no project matched.
 */
export function mapProjectInWorkspace(
  workspace: Workspace,
  id: ProjectId,
  fn: (p: Project) => Project,
): Workspace {
  let changed = false;
  const projects = workspace.projects.map((p) => {
    if (p.id !== id) return p;
    changed = true;
    return fn(p);
  });
  return changed ? { ...workspace, projects } : workspace;
}

/**
 * Stamp the `order` field of every item in `items` with its current index so
 * the explicit ordering survives a round-trip through persistence.
 */
export function reassignOrder<T extends { order?: number }>(items: T[]): T[] {
  return items.map((item, idx) => ({ ...item, order: idx }));
}

// Like reassignOrder, but only stamps items matching `matches`, so
// reordering one folder bucket never touches another's order values.
export function reassignOrderWhere<T extends { order?: number }>(
  items: T[],
  matches: (item: T) => boolean,
): T[] {
  let idx = 0;
  return items.map((item) => (matches(item) ? { ...item, order: idx++ } : item));
}

import type {
  Folder,
  Project,
  ProjectId,
  Workspace,
  WorkspaceId,
  WorkspacesState,
} from "../../workspaces/state/types";
import { optionalString } from "./args";
import { ToolError, type ToolArgs } from "./types";

// Lookups by id first, then by unique name (case-insensitive), then by path.
// Ambiguity is an error naming the candidates rather than a silent pick.

export interface ProjectMatch {
  workspace: Workspace;
  project: Project;
}

function allProjects(state: WorkspacesState): ProjectMatch[] {
  return state.workspaces.flatMap((workspace) =>
    workspace.projects.map((project) => ({ workspace, project })),
  );
}

function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

export function findProjectByRef(state: WorkspacesState, ref: string): ProjectMatch {
  const projects = allProjects(state);
  const byId = projects.find(({ project }) => project.id === ref);
  if (byId) return byId;
  const needle = ref.toLowerCase();
  const byName = projects.filter(({ project }) => project.name.toLowerCase() === needle);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const ids = byName.map(({ project, workspace }) => `${project.id} (${workspace.name})`);
    throw new ToolError(`project name "${ref}" is ambiguous; use an id: ${ids.join(", ")}`);
  }
  const byPath = projects.find(({ project }) => normalizePath(project.path) === normalizePath(ref));
  if (byPath) return byPath;
  throw new ToolError(`no project matches "${ref}" (call polakapi_overview for ids)`);
}

/** Reads `project` (id, name or path); falls back to the active project. */
export function resolveProject(state: WorkspacesState, args: ToolArgs): ProjectMatch {
  const ref = optionalString(args, "project");
  if (ref !== undefined) return findProjectByRef(state, ref);
  const active = state.activeProjectId;
  if (!active) throw new ToolError('no active project; pass "project" (id or name)');
  return findProjectByRef(state, active);
}

export function findWorkspaceByRef(state: WorkspacesState, ref: string): Workspace {
  const byId = state.workspaces.find((workspace) => workspace.id === ref);
  if (byId) return byId;
  const needle = ref.toLowerCase();
  const byName = state.workspaces.filter((workspace) => workspace.name.toLowerCase() === needle);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new ToolError(
      `workspace name "${ref}" is ambiguous; use an id: ${byName.map((w) => w.id).join(", ")}`,
    );
  }
  throw new ToolError(`no workspace matches "${ref}" (call polakapi_overview for ids)`);
}

export function findFolderByRef(workspace: Workspace, ref: string): Folder {
  const folders = workspace.folders ?? [];
  const byId = folders.find((folder) => folder.id === ref);
  if (byId) return byId;
  const needle = ref.toLowerCase();
  const byName = folders.filter((folder) => folder.name.toLowerCase() === needle);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new ToolError(
      `folder name "${ref}" is ambiguous in workspace "${workspace.name}"; use an id`,
    );
  }
  throw new ToolError(`workspace "${workspace.name}" has no folder matching "${ref}"`);
}

export function asProjectId(id: string): ProjectId {
  return id as ProjectId;
}

export function asWorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId;
}

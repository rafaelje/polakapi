import { invoke, InvokeError } from "../../../shared/tauri/invoke";
import { flushSaveWorkspaces } from "../../../shared/persistence/workspaces-store";
import {
  sortedProjectsInFolder,
  sortedWorkspaces,
} from "../../workspaces/state/workspaces-reducer";
import type { Project, Workspace, WorkspacesState } from "../../workspaces/state/types";
import { optionalInteger, optionalString, requiredString, requiredStringArray } from "./args";
import {
  asProjectId,
  findFolderByRef,
  findProjectByRef,
  findWorkspaceByRef,
  resolveProject,
} from "./resolve";
import { requireController, ToolError, type ToolContext, type ToolDef } from "./types";

// Workspaces, folders and projects: the sidebar as the model sees it.

function projectSummary(project: Project, state: WorkspacesState, ctx: ToolContext) {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    active: state.activeProjectId === project.id,
    folderId: project.folderId ?? null,
    pathInvalid: project.pathInvalid === true,
    defaultCli: project.activeCliId ?? "shell",
    liveTerminals: ctx.router.getCount(project.id),
    suspendedTerminals: ctx.router.getSuspendedCount(project.id),
    activity: ctx.router.getActivity(project.id),
  };
}

function workspaceSummary(workspace: Workspace, state: WorkspacesState, ctx: ToolContext) {
  const folders = (workspace.folders ?? []).map((folder) => ({
    id: folder.id,
    name: folder.name,
    path: folder.path ?? null,
    projects: sortedProjectsInFolder(workspace, folder.id).map((project) =>
      projectSummary(project, state, ctx),
    ),
  }));
  return {
    id: workspace.id,
    name: workspace.name,
    folders,
    projects: sortedProjectsInFolder(workspace, undefined).map((project) =>
      projectSummary(project, state, ctx),
    ),
  };
}

function overview(state: WorkspacesState, ctx: ToolContext) {
  return {
    activeProjectId: state.activeProjectId,
    workspaces: sortedWorkspaces(state).map((workspace) => workspaceSummary(workspace, state, ctx)),
  };
}

const PROJECT_ARG = {
  type: "string",
  description: "Project id, unique name or absolute path. Defaults to the active project.",
};

const WORKSPACE_ARG = { type: "string", description: "Workspace id or unique name." };

export const workspaceTools: ToolDef[] = [
  {
    name: "polakapi_overview",
    description:
      "List every workspace with its folders and projects: ids, names, paths, which project is active, how many terminals each project has and its activity state. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (_args, ctx) => overview(requireController(ctx).getState(), ctx),
  },
  {
    name: "polakapi_select_project",
    description: "Make a project the active one (shows its terminals in the main window).",
    inputSchema: {
      type: "object",
      properties: { project: { ...PROJECT_ARG, description: "Project id, unique name or path." } },
      required: ["project"],
    },
    run: (args, ctx) => {
      const controller = requireController(ctx);
      const { project } = findProjectByRef(controller.getState(), requiredString(args, "project"));
      controller.setActiveProject(project.id);
      return { selected: { id: project.id, name: project.name, path: project.path } };
    },
  },
  {
    name: "polakapi_create_workspace",
    description: "Create an empty workspace.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Workspace name." } },
      required: ["name"],
    },
    run: (args, ctx) => {
      const created = requireController(ctx).createWorkspace(requiredString(args, "name"));
      if (!created) throw new ToolError("could not create the workspace");
      return { id: created.id, name: created.name };
    },
  },
  {
    name: "polakapi_add_project",
    description:
      "Register an existing directory as a project in a workspace (optionally inside a folder). The directory must already exist.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the directory." },
        workspace: {
          ...WORKSPACE_ARG,
          description: "Workspace id or name. Defaults to the active project's workspace.",
        },
        name: { type: "string", description: "Display name. Defaults to the directory name." },
        folder: { type: "string", description: "Folder id or name inside the workspace." },
      },
      required: ["path"],
    },
    run: async (args, ctx) => {
      const controller = requireController(ctx);
      const state = controller.getState();
      const path = requiredString(args, "path");
      const workspaceRef = optionalString(args, "workspace");
      const workspace = workspaceRef
        ? findWorkspaceByRef(state, workspaceRef)
        : state.activeProjectId
          ? findProjectByRef(state, state.activeProjectId).workspace
          : state.workspaces[0];
      if (!workspace) throw new ToolError("there is no workspace yet; create one first");
      try {
        await invoke("fs_validate_path", { path }, { toastOnError: false });
      } catch (cause) {
        const raw = cause instanceof InvokeError ? cause.cause : cause;
        throw new ToolError(`invalid path: ${typeof raw === "string" ? raw : String(raw)}`);
      }
      const folderRef = optionalString(args, "folder");
      const folder = folderRef ? findFolderByRef(workspace, folderRef) : undefined;
      const name =
        optionalString(args, "name") ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      const created = controller.addProject(workspace.id, { name, path, folderId: folder?.id });
      if (!created) throw new ToolError("could not add the project");
      return { id: created.id, name: created.name, path: created.path, workspaceId: workspace.id };
    },
  },
  {
    name: "polakapi_create_worktree",
    description:
      "Create a git worktree for a new branch off the project's base branch, in a sibling directory, and register it as a new project. The new project lands next to the source project unless a workspace or folder is given. The new project becomes active.",
    inputSchema: {
      type: "object",
      properties: {
        project: { ...PROJECT_ARG, description: "Source project id, name or path." },
        branch: { type: "string", description: "New branch name (must not exist yet)." },
        workspace: {
          ...WORKSPACE_ARG,
          description: "Move the new project into this workspace after creating it.",
        },
        folder: {
          type: "string",
          description: "Folder id or name in the destination workspace.",
        },
      },
      required: ["branch"],
    },
    run: async (args, ctx) => {
      const controller = requireController(ctx);
      const state = controller.getState();
      const { project: source } = resolveProject(state, args);
      const branch = requiredString(args, "branch");
      const workspaceRef = optionalString(args, "workspace");
      const folderRef = optionalString(args, "folder");
      const destination = workspaceRef ? findWorkspaceByRef(state, workspaceRef) : null;
      const folder = folderRef
        ? findFolderByRef(destination ?? findProjectByRef(state, source.id).workspace, folderRef)
        : undefined;

      const created = await controller.createProjectWorktree(source.id, branch);
      if (!created) {
        throw new ToolError(
          `could not create worktree "${branch}" for ${source.name}; the branch may already exist or the project is not a git repository`,
        );
      }
      if (destination || folder) {
        const next = controller.getState();
        const target = destination ?? findProjectByRef(next, created.id).workspace;
        const bucketSize = target.projects.filter(
          (p) => (p.folderId ?? undefined) === folder?.id,
        ).length;
        controller.moveProjectToBucket(created.id, target.id, folder?.id, bucketSize);
      }
      await flushSaveWorkspaces();
      const final = findProjectByRef(controller.getState(), created.id);
      return {
        id: final.project.id,
        name: final.project.name,
        path: final.project.path,
        branch,
        workspaceId: final.workspace.id,
        folderId: final.project.folderId ?? null,
      };
    },
  },
  {
    name: "polakapi_move_project",
    description:
      "Move a project to a workspace, optionally into one of its folders, at a position (0 = first; omitted = last).",
    inputSchema: {
      type: "object",
      properties: {
        project: { ...PROJECT_ARG, description: "Project id, name or path." },
        workspace: {
          ...WORKSPACE_ARG,
          description: "Destination workspace id or name. Defaults to the project's workspace.",
        },
        folder: {
          type: "string",
          description: 'Destination folder id or name; pass "" to move out of any folder.',
        },
        index: { type: "integer", description: "Position inside the destination bucket." },
      },
      required: ["project"],
    },
    run: (args, ctx) => {
      const controller = requireController(ctx);
      const state = controller.getState();
      const { project, workspace: current } = findProjectByRef(
        state,
        requiredString(args, "project"),
      );
      const workspaceRef = optionalString(args, "workspace");
      const target = workspaceRef ? findWorkspaceByRef(state, workspaceRef) : current;
      const folderRaw = args.folder;
      const folderRef = typeof folderRaw === "string" ? folderRaw.trim() : undefined;
      const folder = folderRef ? findFolderByRef(target, folderRef) : undefined;
      const folderId =
        folderRef === undefined && target.id === current.id ? project.folderId : folder?.id;
      const bucketSize = target.projects.filter(
        (p) => p.id !== project.id && (p.folderId ?? undefined) === folderId,
      ).length;
      const index = optionalInteger(args, "index", { min: 0 }) ?? bucketSize;
      controller.moveProjectToBucket(project.id, target.id, folderId, index);
      return {
        moved: project.id,
        workspaceId: target.id,
        folderId: folderId ?? null,
        index: Math.min(index, bucketSize),
      };
    },
  },
  {
    name: "polakapi_reorder_projects",
    description:
      "Set the order of the projects in a workspace bucket (ungrouped projects, or one folder). Projects not listed keep their relative order after the listed ones.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: WORKSPACE_ARG,
        folder: { type: "string", description: "Folder id or name; omit for ungrouped projects." },
        projects: {
          type: "array",
          items: { type: "string" },
          description: "Project ids (or unique names) in the desired order.",
        },
      },
      required: ["workspace", "projects"],
    },
    run: (args, ctx) => {
      const controller = requireController(ctx);
      const state = controller.getState();
      const workspace = findWorkspaceByRef(state, requiredString(args, "workspace"));
      const folderRef = optionalString(args, "folder");
      const folder = folderRef ? findFolderByRef(workspace, folderRef) : undefined;
      const ordered = requiredStringArray(args, "projects").map((ref) => {
        const match = findProjectByRef(state, ref);
        if (match.workspace.id !== workspace.id) {
          throw new ToolError(
            `project "${match.project.name}" is not in workspace "${workspace.name}"`,
          );
        }
        if ((match.project.folderId ?? undefined) !== folder?.id) {
          throw new ToolError(
            `project "${match.project.name}" is not in that bucket; move it first`,
          );
        }
        return match.project.id;
      });
      controller.reorderProjectsInFolder(workspace.id, folder?.id, ordered);
      return { workspaceId: workspace.id, folderId: folder?.id ?? null, order: ordered };
    },
  },
  {
    name: "polakapi_rename_project",
    description: "Rename a project (display name only; the directory is untouched).",
    inputSchema: {
      type: "object",
      properties: {
        project: { ...PROJECT_ARG, description: "Project id, name or path." },
        name: { type: "string", description: "New display name." },
      },
      required: ["project", "name"],
    },
    run: (args, ctx) => {
      const controller = requireController(ctx);
      const { project } = findProjectByRef(controller.getState(), requiredString(args, "project"));
      const name = requiredString(args, "name");
      controller.renameProject(asProjectId(project.id), name);
      return { id: project.id, name };
    },
  },
];

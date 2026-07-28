import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PathValidation, ProjectId, WorkspaceId, WorkspacesState } from "./types";

const persistence = vi.hoisted(() => ({
  loadWorkspaces: vi.fn<() => Promise<WorkspacesState>>(),
  queueSaveWorkspaces: vi.fn<(state: WorkspacesState) => void>(),
  flushSaveWorkspaces: vi.fn<() => Promise<void>>(),
}));

vi.mock("../../../shared/persistence/workspaces-store", () => persistence);

const pathValidation = vi.hoisted(() => ({
  validatePath: vi.fn<(path: string) => Promise<PathValidation>>(),
}));

vi.mock("../path-validation", () => pathValidation);

const confirmDelete = vi.hoisted(() => ({
  confirmDeleteProject: vi.fn<() => Promise<boolean>>(),
  confirmDeleteWorkspace: vi.fn<() => Promise<boolean>>(),
}));

vi.mock("../forms/confirm-delete", () => confirmDelete);

const tauriInvoke = vi.hoisted(() => {
  class MockInvokeError extends Error {
    constructor(
      readonly command: string,
      readonly cause: unknown,
    ) {
      super(`invoke "${command}" failed`);
    }
  }
  return {
    invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
    InvokeError: MockInvokeError,
  };
});

vi.mock("../../../shared/tauri/invoke", () => tauriInvoke);

const toast = vi.hoisted(() => ({
  showToast: vi.fn<(message: string, variant?: string) => void>(),
}));

vi.mock("../../../shared/ui/toast", () => toast);

import { WorkspacesController } from "./workspaces-controller";

function pid(id: string): ProjectId {
  return id as ProjectId;
}

function wid(id: string): WorkspaceId {
  return id as WorkspaceId;
}

function seededState(): WorkspacesState {
  return {
    schemaVersion: 1,
    activeProjectId: pid("p1"),
    workspaces: [
      {
        id: wid("w1"),
        name: "Workspace",
        projects: [{ id: pid("p1"), name: "Original", path: "/tmp/project" }],
      },
    ],
  };
}

function seededWorkspaceWithProjects(): WorkspacesState {
  return {
    schemaVersion: 1,
    activeProjectId: pid("p1"),
    workspaces: [
      {
        id: wid("w1"),
        name: "Workspace",
        projects: [
          { id: pid("p1"), name: "One", path: "/tmp/one" },
          { id: pid("p2"), name: "Two", path: "/tmp/two" },
        ],
      },
    ],
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("WorkspacesController", () => {
  beforeEach(() => {
    persistence.loadWorkspaces.mockReset();
    persistence.queueSaveWorkspaces.mockReset();
    persistence.flushSaveWorkspaces.mockReset();
    persistence.flushSaveWorkspaces.mockResolvedValue(undefined);
    pathValidation.validatePath.mockReset();
    pathValidation.validatePath.mockResolvedValue({ ok: true });
    confirmDelete.confirmDeleteProject.mockReset();
    confirmDelete.confirmDeleteProject.mockResolvedValue(true);
    confirmDelete.confirmDeleteWorkspace.mockReset();
    confirmDelete.confirmDeleteWorkspace.mockResolvedValue(true);
    tauriInvoke.invoke.mockReset();
    toast.showToast.mockReset();
  });

  it("applies boot path validation without overwriting concurrent state changes", async () => {
    let resolveValidation!: (validation: PathValidation) => void;
    pathValidation.validatePath.mockReturnValue(
      new Promise<PathValidation>((resolve) => {
        resolveValidation = resolve;
      }),
    );
    persistence.loadWorkspaces.mockResolvedValueOnce(seededState());

    const controller = await WorkspacesController.load();
    controller.renameProject(pid("p1"), "Renamed");

    resolveValidation({ ok: false, reason: "not_found" });
    await flushMicrotasks();

    const project = controller.getState().workspaces[0].projects[0];
    expect(project.name).toBe("Renamed");
    expect(project.pathInvalid).toBe(true);
  });

  it("runs project delete hooks before deleting a workspace", async () => {
    persistence.loadWorkspaces.mockResolvedValueOnce(seededWorkspaceWithProjects());
    const controller = await WorkspacesController.load();
    const hookCalls: ProjectId[] = [];
    const projectsVisibleDuringHook: number[] = [];

    controller.setDeleteProjectHook((projectId) => {
      hookCalls.push(projectId);
      projectsVisibleDuringHook.push(controller.getState().workspaces[0]?.projects.length ?? 0);
    });

    await controller.deleteWorkspace(wid("w1"));

    expect(hookCalls).toEqual([pid("p1"), pid("p2")]);
    expect(projectsVisibleDuringHook).toEqual([2, 2]);
    expect(controller.getState().workspaces).toEqual([]);
  });

  it("persists terminal layout updates through the controller", async () => {
    persistence.loadWorkspaces.mockResolvedValueOnce(seededState());
    const controller = await WorkspacesController.load();
    const layout = { type: "pane" as const, paneId: "pty-1" };

    controller.setProjectTerminalLayout(pid("p1"), layout);

    expect(controller.getActiveProject()?.terminalLayout).toEqual(layout);
    expect(persistence.queueSaveWorkspaces).toHaveBeenCalledOnce();
  });

  it("registers a new project pointing at the worktree path on success", async () => {
    persistence.loadWorkspaces.mockResolvedValueOnce(seededState());
    tauriInvoke.invoke.mockResolvedValueOnce("/tmp/project-worktrees/feature-x");
    const controller = await WorkspacesController.load();

    const created = await controller.createProjectWorktree(pid("p1"), "feature/x");

    expect(tauriInvoke.invoke).toHaveBeenCalledWith(
      "git_create_worktree",
      { projectPath: "/tmp/project", branch: "feature/x" },
      { toastOnError: false },
    );
    expect(created?.path).toBe("/tmp/project-worktrees/feature-x");
    expect(created?.name).toBe("Original (feature/x)");
    expect(controller.getState().workspaces[0].projects).toHaveLength(2);
    expect(controller.getActiveProject()?.id).toBe(created?.id);
  });

  it("toasts the raw git error and adds no project on failure", async () => {
    persistence.loadWorkspaces.mockResolvedValueOnce(seededState());
    tauriInvoke.invoke.mockRejectedValueOnce(
      new tauriInvoke.InvokeError(
        "git_create_worktree",
        "fatal: a branch named 'feature/x' already exists",
      ),
    );
    const controller = await WorkspacesController.load();

    const created = await controller.createProjectWorktree(pid("p1"), "feature/x");

    expect(created).toBeNull();
    expect(controller.getState().workspaces[0].projects).toHaveLength(1);
    expect(toast.showToast).toHaveBeenCalledWith(
      "fatal: a branch named 'feature/x' already exists",
      "error",
    );
  });
});

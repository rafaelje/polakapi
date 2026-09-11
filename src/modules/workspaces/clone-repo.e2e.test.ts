import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FolderId,
  PathValidation,
  ProjectId,
  WorkspaceId,
  WorkspacesState,
} from "./state/types";

const persistence = vi.hoisted(() => ({
  loadWorkspaces: vi.fn<() => Promise<WorkspacesState>>(),
  queueSaveWorkspaces: vi.fn<(state: WorkspacesState) => void>(),
  flushSaveWorkspaces: vi.fn<() => Promise<void>>(),
}));
vi.mock("../../shared/persistence/workspaces-store", () => persistence);

const pathValidation = vi.hoisted(() => ({
  validatePath: vi.fn<(path: string) => Promise<PathValidation>>(),
}));
vi.mock("./path-validation", () => pathValidation);

const confirmDelete = vi.hoisted(() => ({
  confirmDeleteProject: vi.fn<() => Promise<boolean>>(),
  confirmDeleteProjects: vi.fn<() => Promise<boolean>>(),
  confirmDeleteWorkspace: vi.fn<() => Promise<boolean>>(),
  confirmDeleteFolder: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("./forms/confirm-delete", () => confirmDelete);

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
vi.mock("../../shared/tauri/invoke", () => tauriInvoke);

const toast = vi.hoisted(() => ({ showToast: vi.fn<(m: string, v?: string) => void>() }));
vi.mock("../../shared/ui/toast", () => toast);

const pathPicker = vi.hoisted(() => ({
  pickProjectFolder: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("./path-picker", () => pathPicker);

const modal = vi.hoisted(() => ({
  promptModal: vi.fn<() => Promise<string | null>>(),
  selectModal: vi.fn<() => Promise<string | null>>(),
  confirmModal: vi.fn<() => Promise<boolean>>(),
}));
vi.mock("../../shared/ui/modal", () => modal);

vi.mock("./drag-drop/drag-drop", () => ({ attach: () => ({ detach: vi.fn() }) }));
vi.mock("./drag-drop/finder-drop", () => ({ attachFinderDrop: () => ({ detach: vi.fn() }) }));

import { WorkspacesController } from "./state/workspaces-controller";
import { mountWorkspacesPanel } from "./panel/workspaces-panel";

function seeded(): WorkspacesState {
  return {
    schemaVersion: 1,
    activeProjectId: "p1" as ProjectId,
    workspaces: [
      {
        id: "w1" as WorkspaceId,
        name: "Workspace",
        projects: [{ id: "p1" as ProjectId, name: "existing", path: "/tmp/existing" }],
      },
    ],
  };
}

/** Mounts the real sidebar against the real controller. Only the Tauri edge is faked. */
async function boot(state: WorkspacesState) {
  persistence.loadWorkspaces.mockResolvedValueOnce(state);
  const controller = await WorkspacesController.load();
  const root = document.createElement("aside");
  const activeOnlyToggle = document.createElement("input");
  activeOnlyToggle.type = "checkbox";
  document.body.append(root, activeOnlyToggle);
  const handle = mountWorkspacesPanel({ root, controller, activeOnlyToggle });
  return { controller, root, activeOnlyToggle, handle };
}

function renderedNames(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".ws-project-name")].map((el) => el.textContent ?? "");
}

describe("clone repo end to end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.replaceChildren();
    pathValidation.validatePath.mockResolvedValue({ ok: true });
  });

  it("clones and shows the new project in the sidebar", async () => {
    const { controller, root, handle } = await boot(seeded());
    modal.promptModal.mockResolvedValueOnce("git@github.com:user/repo.git");
    pathPicker.pickProjectFolder.mockResolvedValueOnce("/srv/repos");
    tauriInvoke.invoke.mockResolvedValueOnce("/srv/repos/repo");

    const created = await controller.cloneRepoInteractive("w1" as WorkspaceId);

    expect(created).toMatchObject({ name: "repo", path: "/srv/repos/repo" });
    expect(renderedNames(root)).toContain("repo");
    handle.unmount();
  });

  it("clones into a folder and shows the project inside it", async () => {
    const state = seeded();
    state.workspaces[0].folders = [{ id: "f1" as FolderId, name: "code", path: "/home/user/code" }];
    const { controller, root, handle } = await boot(state);
    modal.promptModal.mockResolvedValueOnce("git@github.com:user/repo.git");
    tauriInvoke.invoke.mockResolvedValueOnce("/home/user/code/repo");

    const created = await controller.cloneRepoInteractive("w1" as WorkspaceId, {
      folderId: "f1" as FolderId,
    });

    expect(created).toMatchObject({ folderId: "f1" });
    expect(renderedNames(root)).toContain("repo");
    handle.unmount();
  });

  // Documents the defect: the clone lands in state but the sidebar filters it out.
  it("clone lands in state but stays hidden while the active-only filter is on", async () => {
    const { controller, root, activeOnlyToggle, handle } = await boot(seeded());
    activeOnlyToggle.checked = true;
    activeOnlyToggle.dispatchEvent(new Event("change"));

    modal.promptModal.mockResolvedValueOnce("git@github.com:user/repo.git");
    pathPicker.pickProjectFolder.mockResolvedValueOnce("/srv/repos");
    tauriInvoke.invoke.mockResolvedValueOnce("/srv/repos/repo");

    const created = await controller.cloneRepoInteractive("w1" as WorkspaceId);

    expect(created).not.toBeNull();
    expect(controller.getState().workspaces[0].projects).toHaveLength(2);
    // The project exists, yet nothing renders: a fresh clone has no live terminal.
    expect(renderedNames(root)).not.toContain("repo");
    handle.unmount();
  });

  // Documents the defect: a leftover search query hides the freshly cloned project.
  it("clone lands in state but stays hidden while a search filter is typed", async () => {
    const { controller, root, handle } = await boot(seeded());
    const search = root.querySelector<HTMLInputElement>(".ws-panel-search");
    if (!search) throw new Error("search input missing");
    search.value = "existing";
    search.dispatchEvent(new Event("input"));

    modal.promptModal.mockResolvedValueOnce("git@github.com:user/repo.git");
    pathPicker.pickProjectFolder.mockResolvedValueOnce("/srv/repos");
    tauriInvoke.invoke.mockResolvedValueOnce("/srv/repos/repo");

    const created = await controller.cloneRepoInteractive("w1" as WorkspaceId);

    expect(created).not.toBeNull();
    expect(renderedNames(root)).toEqual(["existing"]);
    handle.unmount();
  });

  it("renders the clone even when the target folder is collapsed", async () => {
    const state = seeded();
    state.workspaces[0].folders = [
      { id: "f1" as FolderId, name: "code", path: "/home/user/code", collapsed: true },
    ];
    const { controller, root, handle } = await boot(state);
    modal.promptModal.mockResolvedValueOnce("git@github.com:user/repo.git");
    tauriInvoke.invoke.mockResolvedValueOnce("/home/user/code/repo");

    const created = await controller.cloneRepoInteractive("w1" as WorkspaceId, {
      folderId: "f1" as FolderId,
    });

    expect(created).not.toBeNull();
    expect(renderedNames(root)).toContain("repo");
    handle.unmount();
  });
});

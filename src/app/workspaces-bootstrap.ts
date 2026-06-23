import { promptModal } from "../shared/ui/modal";
import { ptyWrite } from "../modules/terminal/pty-client";
import { WorkspacesController } from "../modules/workspaces/workspaces-controller";
import {
  mountWorkspacesPanel,
  type WorkspacesPanelHandle,
} from "../modules/workspaces/workspaces-panel";
import type { Project, ProjectId } from "../modules/workspaces/types";
import { findProject } from "../modules/workspaces/workspaces-reducer";
import { mountProjectPane, type ProjectPaneHandle } from "./project-pane";
import { mountBreadcrumb, type BreadcrumbHandle } from "./breadcrumb";
import { type AppElements } from "./elements";
import type { TerminalRouter } from "./terminal-router";

export interface WorkspacesBootstrapOptions {
  elements: AppElements;
  router: TerminalRouter;
  clampGridCols: (value: number) => number;
}

export interface WorkspacesBootstrapHandle {
  controller: WorkspacesController;
  panel: WorkspacesPanelHandle;
  projectPane: ProjectPaneHandle;
  breadcrumb: BreadcrumbHandle;
  unsubscribe: () => void;
}

/**
 * Wires the workspaces controller, sidebar panel, project pane sub-toolbar
 * and breadcrumb. Coordinates the TerminalRouter so the active project's
 * terminal grid mounts into the project-pane host on activation and detaches
 * (without dispose) on deactivation.
 */
export async function bootstrapWorkspaces(
  opts: WorkspacesBootstrapOptions,
): Promise<WorkspacesBootstrapHandle> {
  const { elements, router, clampGridCols } = opts;

  const controller = await WorkspacesController.load();
  const panel = mountWorkspacesPanel({
    root: elements.sidebarLeft,
    controller,
    liveCounts: router,
  });

  // Track which projects have already restored their persisted specs so a
  // second activation does not re-spawn the panes.
  const restored = new Set<ProjectId>();

  const projectPane = mountProjectPane({
    host: elements.projectPaneHost,
    gridEl: elements.gridEl,
    gridCols: controller.getActiveProject()?.terminalCols ?? 2,
    callbacks: {
      onAddTerminal: () => {
        const manager = router.getActive();
        if (!manager) return;
        void manager.addPane();
      },
      onRunInAll: () => void runCommandInActivePanes(router),
      onSetGridCols: (value) => {
        const next = clampGridCols(value);
        const active = controller.getActiveProject();
        if (!active) return;
        router.getById(active.id)?.setGridCols(next);
        controller.setProjectCols(active.id, next);
      },
    },
  });
  const breadcrumb = mountBreadcrumb({ host: elements.breadcrumbHost });

  const activateProject = async (project: Project | null): Promise<void> => {
    if (!project) {
      router.unmount();
      return;
    }
    const manager = router.getOrCreate(project);
    router.mount(project.id, elements.gridEl);
    projectPane.setGridCols(manager.gridCols);
    if (!restored.has(project.id)) {
      restored.add(project.id);
      const specs = project.terminals ?? [];
      if (specs.length > 0) {
        await manager.restoreSpecs(specs);
      }
    }
  };

  const refreshActiveContext = (): void => {
    const project = controller.getActiveProject();
    const workspace = project
      ? (findProject(controller.getState(), project.id)?.workspace ?? null)
      : null;
    breadcrumb.update(workspace, project);
    projectPane.setActiveProject(project);
    if (project) elements.projectPaneHost.dataset.projectId = project.id;
    else delete elements.projectPaneHost.dataset.projectId;
  };

  // PTY teardown for project deletion. Runs after the user confirms in the
  // modal and before the reducer removes the project — this keeps sidebar
  // listeners from reading liveCounts for an id state already dropped.
  const unwireDeleteHook = controller.setDeleteProjectHook(async (projectId) => {
    await router.dispose(projectId);
    restored.delete(projectId);
  });

  const unsubscribeController = controller.on((event) => {
    if (event.type === "state-changed") {
      refreshActiveContext();
      // Forward path edits to the router so new panes pick up the new cwd.
      const active = controller.getActiveProject();
      if (active) router.onProjectPathChanged(active.id, active.path);
    }
    if (event.type === "active-project-changed") {
      refreshActiveContext();
      void activateProject(event.project);
    }
  });
  refreshActiveContext();
  // Restore on boot if a project was already active.
  void activateProject(controller.getActiveProject());

  const unsubscribe = (): void => {
    unsubscribeController();
    unwireDeleteHook();
  };

  return { controller, panel, projectPane, breadcrumb, unsubscribe };
}

async function runCommandInActivePanes(router: TerminalRouter): Promise<void> {
  const manager = router.getActive();
  if (!manager) return;
  const cmd = await promptModal({
    title: "Run command in all terminals",
    message: "The command will be sent followed by Enter to every open terminal of this project.",
    placeholder: "e.g. ls",
    confirmLabel: "Run",
  });
  if (!cmd) return;
  const payload = `${cmd}\r`;
  for (const id of manager.ids()) {
    void ptyWrite(id, payload);
  }
}

export type { Project };

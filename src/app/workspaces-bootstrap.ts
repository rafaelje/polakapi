import { promptModal } from "../shared/ui/modal";
import type { TerminalManager } from "../modules/terminal/terminal-manager";
import { ptyWrite } from "../modules/terminal/pty-client";
import { WorkspacesController } from "../modules/workspaces/workspaces-controller";
import {
  mountWorkspacesPanel,
  type WorkspacesPanelHandle,
} from "../modules/workspaces/workspaces-panel";
import type { Project } from "../modules/workspaces/types";
import { findProject } from "../modules/workspaces/workspaces-reducer";
import { mountProjectPane, type ProjectPaneHandle } from "./project-pane";
import { mountBreadcrumb, type BreadcrumbHandle } from "./breadcrumb";
import { type AppElements } from "./elements";
import { queueSave } from "../shared/persistence/store";

export interface WorkspacesBootstrapOptions {
  elements: AppElements;
  paneManager: TerminalManager;
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
 * and breadcrumb. Extracted from AppController to keep that file under the
 * 250-line budget and to centralise the project-context refresh logic.
 */
export async function bootstrapWorkspaces(
  opts: WorkspacesBootstrapOptions,
): Promise<WorkspacesBootstrapHandle> {
  const { elements, paneManager, clampGridCols } = opts;

  const controller = await WorkspacesController.load();
  const panel = mountWorkspacesPanel({
    root: elements.sidebarLeft,
    controller,
  });
  const projectPane = mountProjectPane({
    host: elements.projectPaneHost,
    gridEl: elements.gridEl,
    gridCols: paneManager.gridCols,
    callbacks: {
      onAddTerminal: () => void paneManager.create(),
      onRunInAll: () => void runCommandInAllPanes(paneManager),
      onSetGridCols: (value) => {
        const next = clampGridCols(value);
        paneManager.setGridCols(next);
        queueSave({ gridCols: next });
      },
    },
  });
  const breadcrumb = mountBreadcrumb({ host: elements.breadcrumbHost });

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

  const unsubscribe = controller.on((event) => {
    if (event.type === "state-changed") refreshActiveContext();
    if (event.type === "active-project-changed") refreshActiveContext();
  });
  refreshActiveContext();

  return { controller, panel, projectPane, breadcrumb, unsubscribe };
}

async function runCommandInAllPanes(paneManager: TerminalManager): Promise<void> {
  const cmd = await promptModal({
    title: "Run command in all terminals",
    message: "The command will be sent followed by Enter to every open terminal.",
    placeholder: "e.g. ls",
    confirmLabel: "Run",
  });
  if (!cmd) return;
  const payload = `${cmd}\r`;
  for (const id of paneManager.ids()) {
    void ptyWrite(id, payload);
  }
}

export type { Project };

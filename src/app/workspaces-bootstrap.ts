import { promptModal } from "../shared/ui/modal";
import { ptyWrite } from "../modules/terminal/pty-client";
import { WorkspacesController } from "../modules/workspaces/workspaces-controller";
import {
  mountWorkspacesPanel,
  type BellPendingSource,
  type WorkspacesPanelHandle,
} from "../modules/workspaces/workspaces-panel";
import type { Project, ProjectId } from "../modules/workspaces/types";
import { findProject } from "../modules/workspaces/workspaces-reducer";
import { mountNotesPanel } from "../modules/notes/notes-panel";
import type { NotesPanelHandle, NotesSource } from "../modules/notes/types";
import { mountProjectPane, type ProjectPaneHandle } from "./project-pane";
import { mountBreadcrumb, type BreadcrumbHandle } from "./breadcrumb";
import { type AppElements } from "./elements";
import type { TerminalRouter, TerminalRouterEvent } from "./terminal-router";

export interface WorkspacesBootstrapOptions {
  elements: AppElements;
  router: TerminalRouter;
  clampGridCols: (value: number) => number;
  /**
   * F5: live OS window focus probe. Wired in AppController from window
   * focus/blur listeners so the bell wiring can suppress notifications while
   * the user is actively looking at the active project.
   */
  isWindowFocused: () => boolean;
}

export interface WorkspacesBootstrapHandle {
  controller: WorkspacesController;
  panel: WorkspacesPanelHandle;
  projectPane: ProjectPaneHandle;
  breadcrumb: BreadcrumbHandle;
  /** F3: disposed by AppController BEFORE controller.dispose() so the panel's
   * synchronous final flush lands in state before flushSaveWorkspaces runs. */
  notesPanel: NotesPanelHandle;
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
  const { elements, router, clampGridCols, isWindowFocused } = opts;

  const controller = await WorkspacesController.load();

  // F5: tiny bell bus. The router emits per-pane `bell-pending` events; the
  // panel only needs an `on(listener)` subscription. We re-broadcast the
  // router's events through this bus so the bootstrap can also synthesise a
  // reset event when a project becomes active (no router event would fire
  // for "the user just looked at the bells", so we do it here).
  type BellEvent = {
    type: "bell-pending";
    projectId: ProjectId;
    paneId: string;
    pending: boolean;
  };
  const bellListeners = new Set<(e: BellEvent) => void>();
  const bellSource: BellPendingSource = {
    on: (listener) => {
      bellListeners.add(listener);
      return () => {
        bellListeners.delete(listener);
      };
    },
  };
  const emitBell = (event: BellEvent): void => {
    for (const listener of bellListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Bell listener threw", error);
      }
    }
  };
  const unsubscribeRouterBell = router.on((event: TerminalRouterEvent) => {
    if (event.type !== "bell-pending") return;
    emitBell({
      type: "bell-pending",
      projectId: event.projectId,
      paneId: event.paneId,
      pending: event.pending,
    });
  });

  // F5: wire the router's notification context. The lookups are late-bound so
  // project renames flow into OS notifications without re-registration.
  router.setNotificationContext({
    getActiveProjectId: () => controller.getActiveProject()?.id ?? null,
    isWindowFocused,
    getProjectName: (projectId) =>
      findProject(controller.getState(), projectId)?.project.name ?? "",
    onBellPending: (projectId, paneId, pending) => {
      // Router already re-emits via its own listener path; nothing to do here
      // beyond satisfying the manager's interface. Kept as an explicit hook in
      // case a future feature wants per-manager analytics.
      void projectId;
      void paneId;
      void pending;
    },
  });

  const panel = mountWorkspacesPanel({
    root: elements.sidebarLeft,
    controller,
    liveCounts: router,
    bellSource,
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

  // F3: NotesSource adapter. The panel only needs a narrow view of the
  // controller — current active id, current notes for any id, a write path,
  // and a subscription that fires when the active project changes.
  const notesListeners = new Set<(pid: ProjectId | null) => void>();
  const notesSource: NotesSource = {
    getActiveProjectId: () => controller.getActiveProject()?.id ?? null,
    getNotes: (projectId) => controller.getProjectNotes(projectId),
    setNotes: (projectId, value) => controller.setProjectNotes(projectId, value),
    on: (_event, cb) => {
      notesListeners.add(cb);
      return () => {
        notesListeners.delete(cb);
      };
    },
  };

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
      const pid = event.project?.id ?? null;
      // F5: clear any pending bells for the project the user just opened.
      // paneId="" is the panel-side convention for "clear all panes of this
      // project" (see workspaces-panel.ts coalesce logic).
      if (pid) {
        emitBell({ type: "bell-pending", projectId: pid, paneId: "", pending: false });
      }
      for (const listener of notesListeners) {
        try {
          listener(pid);
        } catch (error) {
          console.error("Notes source listener threw", error);
        }
      }
    }
  });
  refreshActiveContext();
  // Restore on boot if a project was already active.
  void activateProject(controller.getActiveProject());

  const notesPanel = mountNotesPanel({
    elements: elements.notes,
    source: notesSource,
  });

  const unsubscribe = (): void => {
    unsubscribeController();
    unwireDeleteHook();
    unsubscribeRouterBell();
    bellListeners.clear();
    router.setNotificationContext(null);
    notesListeners.clear();
  };

  return { controller, panel, projectPane, breadcrumb, notesPanel, unsubscribe };
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

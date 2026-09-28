import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "../shared/tauri/invoke";
import {
  PROJECT_WINDOW_ADOPT_EVENT,
  PROJECT_WINDOW_CLOSED_EVENT,
  PROJECT_WINDOW_UPDATE_EVENT,
  isProjectWindowClosed,
  isProjectWindowUpdate,
  paneWindowId,
  type AdoptedPane,
  type ProjectWindowState,
} from "../modules/project-window/protocol";
import type { TerminalLayoutNode } from "../modules/terminal/terminal-layout";
import type { TerminalSpec } from "../modules/terminal/types";
import type { Project, ProjectId } from "../modules/workspaces/state/types";
import type { ReleasedGrid, TerminalRouter } from "./terminal-router";

// Main-window side of terminals living in their own windows: a project's whole
// grid, or single terminals torn off by dragging them out. Keeps the last state
// each window reported so everything comes back exactly as it was, and takes
// it back when the window closes. Processes never stop.

export interface ProjectWindowsDeps {
  router: TerminalRouter;
  findProject(projectId: ProjectId): Project | null;
  persistSpecs(projectId: ProjectId, specs: TerminalSpec[]): void;
  persistLayout(projectId: ProjectId, layout: TerminalLayoutNode | null): void;
  onBell(projectId: ProjectId, paneId: string, pending: boolean): void;
  /** The grid is back in this window; re-activate it if it is the active project. */
  onReturned(projectId: ProjectId): void;
}

export interface ProjectWindowsHandle {
  /** True when the project's whole grid is in its own window. */
  isDetached(projectId: ProjectId): boolean;
  detach(project: Project): Promise<void>;
  tearOff(project: Project, ptyId: string, at?: { x: number; y: number }): Promise<void>;
  bringBack(projectId: ProjectId): Promise<void>;
  focus(projectId: ProjectId): Promise<void>;
  dispose(): void;
}

interface OpenWindow {
  projectId: ProjectId;
  /** A whole grid persists as the project's terminals; a torn-off pane does not. */
  whole: boolean;
  grid: ReleasedGrid;
}

export async function createProjectWindows(
  deps: ProjectWindowsDeps,
): Promise<ProjectWindowsHandle> {
  const { router } = deps;
  const open = new Map<string, OpenWindow>();

  const open_ = async (
    windowId: string,
    project: Project,
    entry: OpenWindow,
    title: string,
    at?: { x: number; y: number },
  ): Promise<void> => {
    open.set(windowId, entry);
    router.setExternalCount(
      windowId,
      project.id,
      entry.grid.specs.filter((spec) => !spec.suspended).length,
    );
    const state: ProjectWindowState = {
      windowId,
      projectId: project.id,
      title,
      payload: { path: project.path, ...entry.grid },
      position: at ? [at.x, at.y] : undefined,
    };
    try {
      await invoke("project_window_open", { state }, { toastOnError: true });
    } catch (error) {
      // The window never opened: put everything straight back.
      await returnWindow(windowId);
      throw error;
    }
  };

  const returnWindow = async (windowId: string): Promise<void> => {
    const entry = open.get(windowId);
    if (!entry) return;
    open.delete(windowId);
    router.setExternalCount(windowId, entry.projectId, null);
    const project = deps.findProject(entry.projectId);
    if (!project) return;
    if (entry.whole) {
      await router.adopt(project, entry.grid);
      deps.onReturned(entry.projectId);
      return;
    }
    // A torn-off pane goes back to wherever its project's grid is now.
    if (open.has(entry.projectId)) {
      for (const spec of entry.grid.specs) {
        const adopted: AdoptedPane = { spec, snapshot: entry.grid.snapshots?.[spec.id] ?? null };
        await emitTo(`project-${entry.projectId}`, PROJECT_WINDOW_ADOPT_EVENT, adopted);
      }
    } else if (
      !(await router.adoptPanes(entry.projectId, entry.grid.specs, entry.grid.snapshots))
    ) {
      await router.adopt(project, entry.grid);
      deps.onReturned(entry.projectId);
    }
  };

  const unlisten: UnlistenFn[] = [
    await listen(PROJECT_WINDOW_UPDATE_EVENT, ({ payload }) => {
      if (!isProjectWindowUpdate(payload)) return;
      const entry = open.get(payload.windowId);
      if (!entry) return;
      const projectId = entry.projectId;
      if (payload.specs) {
        entry.grid.specs = payload.specs;
        if (entry.whole) deps.persistSpecs(projectId, payload.specs);
      }
      if ("layout" in payload) {
        entry.grid.layout = payload.layout ?? null;
        if (entry.whole) deps.persistLayout(projectId, entry.grid.layout);
      }
      if (payload.liveCount !== undefined) {
        router.setExternalCount(payload.windowId, projectId, payload.liveCount);
      }
      if (payload.bell) deps.onBell(projectId, payload.bell.paneId, payload.bell.pending);
      if (payload.snapshots) entry.grid.snapshots = payload.snapshots;
    }),
    await listen(PROJECT_WINDOW_CLOSED_EVENT, ({ payload }) => {
      if (!isProjectWindowClosed(payload)) return;
      void returnWindow(payload.windowId).catch((error: unknown) =>
        console.error("project window: could not take its terminals back", error),
      );
    }),
  ];

  return {
    isDetached: (projectId) => open.get(projectId)?.whole === true,
    async detach(project) {
      if (open.has(project.id)) {
        await invoke("project_window_focus", { windowId: project.id });
        return;
      }
      const grid = await router.release(project.id);
      if (!grid) return;
      await open_(project.id, project, { projectId: project.id, whole: true, grid }, project.name);
    },
    async tearOff(project, ptyId, at) {
      const torn = await router.tearOff(project.id, ptyId);
      if (!torn) return;
      const { spec, snapshot } = torn;
      const grid: ReleasedGrid = {
        specs: [spec],
        layout: { type: "pane", paneId: spec.id },
        activeCliId: spec.cliId ?? "shell",
        snapshots: snapshot ? { [spec.id]: snapshot } : undefined,
      };
      const title = spec.title ? `${project.name} · ${spec.title}` : project.name;
      await open_(
        paneWindowId(project.id, ptyId),
        project,
        { projectId: project.id, whole: false, grid },
        title,
        at,
      );
    },
    async bringBack(projectId) {
      if (!open.has(projectId)) return;
      // Closing the window is what brings the grid back (see returnWindow).
      await invoke("project_window_close", { windowId: projectId }, { toastOnError: true });
    },
    async focus(projectId) {
      if (!open.has(projectId)) return;
      await invoke("project_window_focus", { windowId: projectId }, { toastOnError: false });
    },
    dispose() {
      for (const stop of unlisten) stop();
    },
  };
}

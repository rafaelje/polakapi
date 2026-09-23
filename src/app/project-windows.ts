import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "../shared/tauri/invoke";
import {
  PROJECT_WINDOW_CLOSED_EVENT,
  PROJECT_WINDOW_UPDATE_EVENT,
  isProjectWindowClosed,
  isProjectWindowUpdate,
  type ProjectWindowState,
} from "../modules/project-window/protocol";
import type { TerminalLayoutNode } from "../modules/terminal/terminal-layout";
import type { TerminalSpec } from "../modules/terminal/types";
import type { Project, ProjectId } from "../modules/workspaces/state/types";
import type { ReleasedGrid, TerminalRouter } from "./terminal-router";

// Main-window side of "open in its own window": hands a project's grid to a
// new window, keeps the last state that window reported so the grid can come
// back exactly as it was, and takes it back when the window closes.

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
  isDetached(projectId: ProjectId): boolean;
  detach(project: Project): Promise<void>;
  bringBack(projectId: ProjectId): Promise<void>;
  focus(projectId: ProjectId): Promise<void>;
  dispose(): void;
}

export async function createProjectWindows(
  deps: ProjectWindowsDeps,
): Promise<ProjectWindowsHandle> {
  const { router } = deps;
  const detached = new Map<ProjectId, ReleasedGrid>();

  const onClosed = async (projectId: ProjectId): Promise<void> => {
    const grid = detached.get(projectId);
    if (!grid) return;
    detached.delete(projectId);
    router.setExternalCount(projectId, null);
    const project = deps.findProject(projectId);
    if (!project) return;
    await router.adopt(project, grid);
    deps.onReturned(projectId);
  };

  const unlisten: UnlistenFn[] = [
    await listen(PROJECT_WINDOW_UPDATE_EVENT, ({ payload }) => {
      if (!isProjectWindowUpdate(payload)) return;
      const projectId = payload.projectId as ProjectId;
      const grid = detached.get(projectId);
      if (!grid) return;
      if (payload.specs) {
        grid.specs = payload.specs;
        deps.persistSpecs(projectId, payload.specs);
      }
      if ("layout" in payload) {
        grid.layout = payload.layout ?? null;
        deps.persistLayout(projectId, grid.layout);
      }
      if (payload.liveCount !== undefined) router.setExternalCount(projectId, payload.liveCount);
      if (payload.bell) deps.onBell(projectId, payload.bell.paneId, payload.bell.pending);
    }),
    await listen(PROJECT_WINDOW_CLOSED_EVENT, ({ payload }) => {
      if (!isProjectWindowClosed(payload)) return;
      void onClosed(payload.projectId as ProjectId).catch((error: unknown) =>
        console.error("project window: could not take the grid back", error),
      );
    }),
  ];

  return {
    isDetached: (projectId) => detached.has(projectId),
    async detach(project) {
      if (detached.has(project.id)) {
        await invoke("project_window_focus", { projectId: project.id });
        return;
      }
      const grid = await router.release(project.id);
      if (!grid) return;
      detached.set(project.id, grid);
      router.setExternalCount(project.id, grid.specs.filter((s) => !s.suspended).length);
      const state: ProjectWindowState = {
        projectId: project.id,
        title: project.name,
        payload: { path: project.path, ...grid },
      };
      try {
        await invoke("project_window_open", { state }, { toastOnError: true });
      } catch (error) {
        // The window never opened: put the grid straight back.
        detached.delete(project.id);
        router.setExternalCount(project.id, null);
        await router.adopt(project, grid);
        deps.onReturned(project.id);
        throw error;
      }
    },
    async bringBack(projectId) {
      if (!detached.has(projectId)) return;
      // Closing the window is what brings the grid back (see onClosed).
      await invoke("project_window_close", { projectId }, { toastOnError: true });
    },
    async focus(projectId) {
      if (!detached.has(projectId)) return;
      await invoke("project_window_focus", { projectId }, { toastOnError: false });
    },
    dispose() {
      for (const stop of unlisten) stop();
    },
  };
}

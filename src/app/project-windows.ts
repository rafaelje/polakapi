import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ptyKill } from "../modules/terminal/pty-client";
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
  deleteProject(projectId: ProjectId): Promise<void>;
  dispose(): void;
}

interface OpenWindow {
  projectId: ProjectId;
  /** Distinguishes a whole grid from terminals torn off its local manager. */
  whole: boolean;
  grid: ReleasedGrid;
  opening?: Promise<void>;
  closing?: boolean;
  pending?: Map<string, AdoptedPane>;
}

export async function createProjectWindows(
  deps: ProjectWindowsDeps,
): Promise<ProjectWindowsHandle> {
  const { router } = deps;
  const open = new Map<string, OpenWindow>();
  const deleted = new Set<ProjectId>();

  const open_ = async (
    windowId: string,
    project: Project,
    entry: OpenWindow,
    title: string,
    at?: { x: number; y: number },
  ): Promise<void> => {
    if (deleted.has(project.id)) {
      await Promise.all(
        entry.grid.specs.filter((spec) => !spec.suspended).map((spec) => ptyKill(spec.id)),
      );
      return;
    }
    open.set(windowId, entry);
    router.setExternalLayout(windowId, project.id, entry.grid.layout);
    router.setExternalSpecs(windowId, project.id, entry.grid.specs);
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
      entry.opening = invoke<void>("project_window_open", { state }, { toastOnError: true });
      await entry.opening;
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
      router.setExternalSpecs(windowId, entry.projectId, null);
      deps.onReturned(entry.projectId);
      return;
    }
    // A torn-off pane goes back to wherever its project's grid is now.
    if (open.has(entry.projectId)) {
      const destination = open.get(entry.projectId)!;
      destination.pending ??= new Map();
      const returning = entry.grid.specs.map(
        (spec): AdoptedPane => ({
          adoptionId: crypto.randomUUID(),
          spec,
          snapshot: entry.grid.snapshots?.[spec.id] ?? null,
        }),
      );
      for (const adopted of returning) {
        const { spec } = adopted;
        destination.pending.set(adopted.adoptionId, adopted);
        destination.grid.specs = [
          ...destination.grid.specs.filter((item) => item.id !== spec.id),
          spec,
        ];
        if (adopted.snapshot) {
          destination.grid.snapshots = {
            ...destination.grid.snapshots,
            [spec.id]: adopted.snapshot,
          };
        }
      }
      router.setExternalSpecs(entry.projectId, entry.projectId, destination.grid.specs);
      for (const adopted of returning) {
        if (destination.closing || open.get(entry.projectId) !== destination) break;
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await emitTo(`project-${entry.projectId}`, PROJECT_WINDOW_ADOPT_EVENT, adopted).catch(
          (error: unknown) =>
            console.error("project window: could not deliver returned terminal", error),
        );
      }
    } else if (
      !(await router.adoptPanes(entry.projectId, entry.grid.specs, entry.grid.snapshots))
    ) {
      await router.adopt(project, entry.grid);
      deps.onReturned(entry.projectId);
    }
    router.setExternalSpecs(windowId, entry.projectId, null);
  };

  const unlisten: UnlistenFn[] = [
    await listen(PROJECT_WINDOW_UPDATE_EVENT, ({ payload }) => {
      if (!isProjectWindowUpdate(payload)) return;
      const entry = open.get(payload.windowId);
      if (!entry) return;
      const projectId = entry.projectId;
      if (payload.projectId !== projectId) return;
      if (payload.closing) entry.closing = true;
      for (const adoptionId of payload.adopted ?? []) entry.pending?.delete(adoptionId);
      if (payload.specs) {
        const reported = new Set(payload.specs.map((spec) => spec.id));
        entry.grid.specs = [
          ...payload.specs,
          ...[...(entry.pending?.values() ?? [])]
            .map((pane) => pane.spec)
            .filter((spec) => !reported.has(spec.id)),
        ];
        router.setExternalSpecs(payload.windowId, projectId, entry.grid.specs);
      }
      if ("layout" in payload) {
        entry.grid.layout = payload.layout ?? null;
        router.setExternalLayout(payload.windowId, projectId, entry.grid.layout);
      }
      if (payload.liveCount !== undefined) {
        router.setExternalCount(payload.windowId, projectId, payload.liveCount);
      }
      if (payload.bell) deps.onBell(projectId, payload.bell.paneId, payload.bell.pending);
      if (payload.snapshots) entry.grid.snapshots = { ...payload.snapshots };
      for (const pane of entry.pending?.values() ?? []) {
        if (pane.snapshot && !entry.grid.snapshots?.[pane.spec.id]) {
          entry.grid.snapshots = { ...entry.grid.snapshots, [pane.spec.id]: pane.snapshot };
        }
      }
      if (entry.grid.snapshots) {
        const ids = new Set(entry.grid.specs.map((spec) => spec.id));
        entry.grid.snapshots = Object.fromEntries(
          Object.entries(entry.grid.snapshots).filter(([id]) => ids.has(id)),
        );
      }
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
      if (deleted.has(project.id)) return;
      if (open.has(project.id)) {
        await invoke("project_window_focus", { windowId: project.id });
        return;
      }
      const grid = await router.release(project.id);
      if (!grid) return;
      await open_(project.id, project, { projectId: project.id, whole: true, grid }, project.name);
    },
    async tearOff(project, ptyId, at) {
      if (deleted.has(project.id)) return;
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
    async deleteProject(projectId) {
      deleted.add(projectId);
      const windowIds: string[] = [];
      const opening: Promise<void>[] = [];
      for (const [windowId, entry] of open) {
        if (entry.projectId !== projectId) continue;
        open.delete(windowId);
        windowIds.push(windowId);
        if (entry.opening) opening.push(entry.opening);
      }
      await router.dispose(projectId);
      await Promise.allSettled(opening);
      await Promise.all(
        windowIds.map((windowId) =>
          invoke("project_window_close", { windowId }, { toastOnError: true }),
        ),
      );
    },
    dispose() {
      for (const stop of unlisten) stop();
    },
  };
}

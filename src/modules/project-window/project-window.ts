import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { wireShortcuts } from "../../shared/keyboard/shortcuts";
import { invoke } from "../../shared/tauri/invoke";
import { onPtyData, onPtyExit } from "../terminal/pty-client";
import { snapshotPanes } from "../terminal/pane-snapshots";
import { attachTerminalDrop } from "../terminal/terminal-drop";
import { TerminalManager } from "../terminal/terminal-manager";
import type { ProjectId } from "../workspaces/state/types";
import {
  PROJECT_WINDOW_ADOPT_EVENT,
  PROJECT_WINDOW_UPDATE_EVENT,
  isAdoptedPane,
  type ProjectWindowState,
  type ProjectWindowUpdate,
} from "./protocol";
import "./project-window.css";

// A project's terminal grid in its own native window. The PTYs were started
// by the main window and keep running; this window only renders them, and
// tells `main` about every change so persistence and the sidebar stay right.

// Measured against the moment main asked for the window, see project_window_ready.
const scriptStarted = performance.now();

async function start(): Promise<void> {
  const host = document.querySelector<HTMLElement>("#grid")!;
  const state = await invoke<ProjectWindowState>("project_window_state");
  const stateLoaded = performance.now();
  const projectId = state.projectId as ProjectId;
  const { payload, title, windowId } = state;

  // Bells are suppressed while the user is looking at this window, not main.
  let focused = document.hasFocus();
  window.addEventListener("focus", () => {
    focused = true;
  });
  window.addEventListener("blur", () => {
    focused = false;
  });

  const send = (update: Omit<ProjectWindowUpdate, "projectId" | "windowId">): void => {
    void emitTo("main", PROJECT_WINDOW_UPDATE_EVENT, { windowId, projectId, ...update }).catch(
      (error: unknown) => console.error("project window: could not reach main", error),
    );
  };

  const manager = new TerminalManager({
    projectId,
    defaultCwd: payload.path,
    layout: payload.layout ?? undefined,
    activeCliId: payload.activeCliId,
    notificationContext: {
      getActiveProjectId: () => projectId,
      isWindowFocused: () => focused,
      getProjectName: () => title,
      onBellPending: () => {},
    },
  });
  host.append(manager.gridEl);
  manager.on((event) => {
    switch (event.type) {
      case "count-changed":
        send({ liveCount: event.count });
        break;
      case "spec-changed":
        send({ specs: event.specs });
        break;
      case "layout-changed":
        send({ layout: event.layout });
        break;
      case "bell-pending":
        send({ bell: { paneId: event.paneId, pending: event.pending } });
        break;
    }
  });

  let closing = false;
  let closePromise: Promise<void> | null = null;
  const currentWindow = getCurrentWebviewWindow();
  // Listen before adopting, so nothing printed during the takeover is lost.
  const initialized: Promise<void> = Promise.all([
    onPtyData(({ id, data, offset }) => {
      manager.get(id)?.write(data, offset);
    }),
    onPtyExit(({ id }) => {
      const pane = manager.get(id);
      if (!pane) return;
      pane.markExited();
      manager.markExited(id);
    }),
    // A terminal torn off this project comes back here while the grid is out.
    currentWindow.listen(PROJECT_WINDOW_ADOPT_EVENT, ({ payload: adopted }) => {
      if (closing || !isAdoptedPane(adopted)) return;
      void manager
        .addPane(adopted.spec, {
          adoptPtyId: adopted.spec.id,
          skipStartupCmd: true,
          snapshot: adopted.snapshot ?? undefined,
        })
        .then((pane) => {
          if (!pane) return;
          send({
            adopted: [adopted.adoptionId],
            specs: manager.specs(),
            layout: manager.layoutSnapshot,
            liveCount: manager.size,
          });
        })
        .catch((error: unknown) =>
          console.error("project window: could not adopt terminal", error),
        );
    }),
    // Hands main what every pane shows before the window goes, so the
    // terminals come back with their colors instead of a raw replay.
    currentWindow.onCloseRequested(() => {
      if (closePromise) return closePromise;
      closing = true;
      document.body.inert = true;
      closePromise = (async () => {
        try {
          send({ closing: true });
          // Listener registration must finish before the initial panes can attach.
          await initialized;
          if (!(await manager.freeze())) return;
          const snapshots = await snapshotPanes(manager);
          await emitTo("main", PROJECT_WINDOW_UPDATE_EVENT, {
            windowId,
            projectId,
            closing: true,
            specs: manager.specs(),
            layout: manager.layoutSnapshot,
            liveCount: manager.size,
            snapshots,
          });
        } catch (error) {
          console.error("project window: could not hand its terminals back", error);
        }
      })();
      return closePromise;
    }),
  ]).then(() => manager.restoreSpecs(payload.specs, { adopt: true, snapshots: payload.snapshots }));

  await initialized;
  manager.refit();
  send({ liveCount: manager.size });
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const slowest = performance
    .getEntriesByType("resource")
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 3)
    .map((entry) => `${Math.round(entry.duration)}ms ${entry.name.split("/").pop() ?? ""}`)
    .join(", ");
  void invoke("project_window_ready", {
    timings: {
      scriptStarted,
      stateLoaded,
      panesAdopted: performance.now(),
      panes: payload.specs.length,
      htmlReceived: navigation?.responseEnd ?? -1,
      domLoaded: navigation?.domContentLoadedEventEnd ?? -1,
      resources: performance.getEntriesByType("resource").length,
      slowest,
    },
  });
  new ResizeObserver(() => manager.refit()).observe(host);

  attachTerminalDrop({ gridEl: manager.gridEl, router: { getActiveHost: () => host } });
  wireShortcuts({
    newPane: () => {
      if (!closing) void manager.addPane();
    },
    splitPane: (position) => {
      if (!closing) void manager.addPane(undefined, { splitPosition: position });
    },
    closeFocused: () => {
      if (!closing) manager.closeFocused();
    },
    focusByIndex: (idx) => manager.focusByIndex(idx),
    focusPrev: () => manager.focusRelative(-1),
    focusNext: () => manager.focusRelative(1),
    focusDirection: (direction) => manager.focusDirection(direction),
    togglePalette: () => {},
    toggleMenuBar: () => {},
  });
}

void start().catch((error: unknown) => {
  const host = document.querySelector<HTMLElement>("#grid");
  if (!host) return;
  const message = document.createElement("p");
  message.className = "project-window-error";
  message.textContent = `Could not open this project's terminals: ${String(error)}`;
  host.replaceChildren(message);
});

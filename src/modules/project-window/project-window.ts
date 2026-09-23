import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { wireShortcuts } from "../../shared/keyboard/shortcuts";
import { invoke } from "../../shared/tauri/invoke";
import { onPtyData, onPtyExit } from "../terminal/pty-client";
import { attachTerminalDrop } from "../terminal/terminal-drop";
import { TerminalManager } from "../terminal/terminal-manager";
import type { ProjectId } from "../workspaces/state/types";
import {
  PROJECT_WINDOW_ADOPT_EVENT,
  PROJECT_WINDOW_UPDATE_EVENT,
  isTerminalSpecPayload,
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

  // Listen before adopting, so nothing printed during the takeover is lost.
  await onPtyData(({ id, data }) => {
    const pane = manager.get(id);
    if (!pane) return;
    pane.write(data);
  });
  await onPtyExit(({ id }) => {
    const pane = manager.get(id);
    if (!pane) return;
    pane.markExited();
    manager.markExited(id);
  });

  // A terminal torn off this project comes back here while the grid is out.
  await getCurrentWebviewWindow().listen(PROJECT_WINDOW_ADOPT_EVENT, ({ payload: spec }) => {
    if (!isTerminalSpecPayload(spec) || manager.get(spec.id)) return;
    void manager.addPane(spec, { adoptPtyId: spec.id, skipStartupCmd: true });
  });

  await manager.restoreSpecs(payload.specs, { adopt: true });
  manager.refit();
  send({ liveCount: manager.size });
  void invoke("project_window_ready", {
    timings: {
      scriptStarted,
      stateLoaded,
      panesAdopted: performance.now(),
      panes: payload.specs.length,
    },
  });
  new ResizeObserver(() => manager.refit()).observe(host);

  attachTerminalDrop({ gridEl: manager.gridEl, router: { getActiveHost: () => host } });
  wireShortcuts({
    newPane: () => void manager.addPane(),
    splitPane: (position) => void manager.addPane(undefined, { splitPosition: position }),
    closeFocused: () => manager.closeFocused(),
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

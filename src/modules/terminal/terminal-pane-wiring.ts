import type { TerminalDockPosition } from "./terminal-layout";
import { attachTerminalDocking, type TerminalDockingHandle } from "./terminal-docking";
import type { TerminalPane } from "./terminal-pane";
import { ptyWrite } from "./pty-client";
import { shouldReplayShellCommand } from "./resume-whitelist";
import type { TerminalSpec } from "./types";

// Delay before piping text into a freshly-spawned PTY, long enough for the
// shell to print its first prompt.
const SCHEDULED_WRITE_DELAY_MS = 200;

// Narrow surface wireTerminalPane needs from TerminalManager, kept in its
// own file purely for the repo's line budget.
export interface PaneWiringHost {
  grid: HTMLElement;
  isLive(ptyId: string): boolean;
  getSpec(ptyId: string): TerminalSpec | undefined;
  updateSpec(ptyId: string, patch: Partial<Omit<TerminalSpec, "id">>): void;
  requestRespawn(ptyId: string, cliId: string): void | Promise<void>;
  suspendPane(ptyId: string): void;
  resumePane(ptyId: string): void | Promise<void>;
  dockAtRoot(ptyId: string, position: TerminalDockPosition): void;
  dock(sourceId: string, targetId: string, position: TerminalDockPosition): void;
  setFocus(ptyId: string): void;
  close(ptyId: string): void | Promise<void>;
  orderLength(): number;
}

// Wires every pane-level callback plus docking and header/close handlers.
export function wireTerminalPane(
  pane: TerminalPane,
  ptyId: string,
  host: PaneWiringHost,
): TerminalDockingHandle {
  pane.setStartupCmdCallbacks({
    getStartupCmd: () => host.getSpec(ptyId)?.startupCmd,
    onChange: (next) => host.updateSpec(ptyId, { startupCmd: next }),
  });
  pane.setCliRespawnCallbacks({
    getCurrentCliId: () => host.getSpec(ptyId)?.cliId ?? "shell",
    onRespawnRequest: (cliId) => {
      void host.requestRespawn(ptyId, cliId);
    },
  });
  pane.setDockMenuCallbacks({
    canDock: () => host.orderLength() > 1,
    onDockAtEdge: (position) => host.dockAtRoot(ptyId, position),
  });
  pane.setSuspendCallbacks({
    isLive: () => host.isLive(ptyId),
    isSuspended: () => host.getSpec(ptyId)?.suspended === true,
    onSuspendRequest: () => host.suspendPane(ptyId),
    onResumeRequest: () => void host.resumePane(ptyId),
  });
  pane.setShellCommandCallbacks({
    onCommand: (command, isAlias) => {
      const eligible = shouldReplayShellCommand(command, isAlias);
      host.updateSpec(ptyId, {
        lastShellCommand: eligible ? command : undefined,
        lastShellCommandAlias: eligible && isAlias ? true : undefined,
      });
    },
  });

  const dockingHandle = attachTerminalDocking({
    handle: pane.headerEl,
    grid: host.grid,
    paneId: ptyId,
    onDock: (sourceId, targetId, position) => host.dock(sourceId, targetId, position),
  });
  pane.el.addEventListener("mousedown", () => host.setFocus(ptyId));
  pane.bodyEl.addEventListener("focusin", () => host.setFocus(ptyId));
  pane.closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void host.close(ptyId);
  });
  return dockingHandle;
}

// Fire-and-forget: pipes `text\r` into `ptyId` after the shell prints its prompt.
export function scheduleTerminalWrite(
  panes: ReadonlyMap<string, TerminalPane>,
  ptyId: string,
  text: string | undefined,
  label: string,
): void {
  if (!text || text.trim().length === 0) return;
  setTimeout(() => {
    if (!panes.has(ptyId)) return;
    void ptyWrite(ptyId, `${text}\r`).catch((error) => {
      console.error(`Failed to write ${label}`, error);
    });
  }, SCHEDULED_WRITE_DELAY_MS);
}

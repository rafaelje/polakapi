import type { TerminalDockPosition } from "./terminal-layout";
import { attachTerminalDocking, type TerminalDockingHandle } from "./terminal-docking";
import type { TerminalPane } from "./terminal-pane";
import { ptyWrite } from "./pty-client";
import type { TerminalSpec } from "./types";

/**
 * Empirical delay before piping text (startupCmd or a replayed
 * lastShellCommand) into a freshly-spawned PTY. Long enough for zsh/bash on
 * macOS + Linux to print their first prompt; short enough to feel
 * instantaneous. Fire-and-forget — we do not parse PS1.
 */
const SCHEDULED_WRITE_DELAY_MS = 200;

/**
 * Narrow surface `wireTerminalPane` needs from `TerminalManager`, built as a
 * small adapter object by the manager itself (bound closures over its own
 * private state) — kept in its own file purely to keep `terminal-manager.ts`
 * under the repo's line budget, not to loosen the manager's encapsulation.
 */
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

/**
 * Wires every pane-level callback (startup-cmd edit, CLI respawn, dock menu,
 * suspend/resume, shell-command capture) plus cross-pane docking and the
 * header mousedown / body focus / close-button handlers. Returns the docking
 * handle so the caller can dispose it alongside the pane.
 */
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
    onCommand: (command) => host.updateSpec(ptyId, { lastShellCommand: command }),
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

/**
 * Fire-and-forget: pipes `text\r` into `ptyId` once the shell has had time to
 * print its prompt. Used for both `startupCmd` (spawn) and a replayed
 * `lastShellCommand` (resume) — `label` only affects the error log so a
 * failure is traceable to which one it was.
 */
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

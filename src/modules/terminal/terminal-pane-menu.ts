import { confirmModal, promptModal } from "../../shared/ui/modal";
import { clampPopoverToViewport } from "../../shared/ui/popover-position";
import { isMacPlatform } from "../../shared/keyboard/shortcuts";
import { ALL_PROFILES, resolveProfile, type CliProfile } from "./cli-registry";
import type { TerminalDockPosition } from "./terminal-layout";
import type { StartupCmdEditCallbacks, SuspendCallbacks } from "./terminal-pane-types";

/**
 * Pane header kebab menu. Extracted from terminal-pane.ts so the pane class
 * keeps its single responsibility (xterm + PTY plumbing) and the file stays
 * under the 200-line ceiling. The popover follows the same lifecycle contract
 * as the workspace row menus: close on outside-click, Escape, scroll, resize.
 */
export interface PaneMenuOptions {
  trigger: HTMLElement;
  getStartupCmd(): string | undefined;
  onChangeStartupCmd(next: string | undefined): void;
  canDock(): boolean;
  onDockAtEdge(position: TerminalDockPosition): void;
  suspend?: SuspendCallbacks | null;
}

export interface PaneMenuHandle {
  dispose(): void;
}

export function openPaneMenu(opts: PaneMenuOptions): PaneMenuHandle {
  // A second invocation reuses the same DOM slot — tear down any previous
  // popover (even one belonging to a sibling pane) before mounting a new one.
  document.querySelectorAll(".pane-menu-popover").forEach((node) => node.remove());

  const popover = document.createElement("div");
  popover.className = "pane-menu-popover";
  const rect = opts.trigger.getBoundingClientRect();
  popover.style.position = "fixed";
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.left = `${Math.max(8, rect.right - 220)}px`;

  const editItem = document.createElement("button");
  editItem.type = "button";
  editItem.className = "pane-menu-item";
  editItem.textContent = "Edit startup command…";
  popover.append(editItem);

  const suspend = opts.suspend;
  if (suspend) {
    const suspended = suspend.isSuspended();
    const item = document.createElement("button");
    item.type = "button";
    item.className = "pane-menu-item";
    item.textContent = suspended ? "Resume" : "Suspend (free RAM)";
    item.disabled = !suspended && !suspend.isLive();
    item.addEventListener("click", () => {
      dispose();
      if (suspended) suspend.onResumeRequest();
      else suspend.onSuspendRequest();
    });
    popover.append(item);
  }

  const separator = document.createElement("div");
  separator.className = "pane-menu-separator";
  popover.append(separator);
  const canDock = opts.canDock();
  for (const [position, label] of DOCK_MENU_ITEMS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "pane-menu-item";
    item.textContent = label;
    item.disabled = !canDock;
    item.dataset.dockPosition = position;
    item.addEventListener("click", () => {
      dispose();
      opts.onDockAtEdge(position);
    });
    popover.append(item);
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    popover.remove();
    window.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", dispose);
    window.removeEventListener("scroll", dispose, true);
  };
  const onOutside = (e: MouseEvent): void => {
    if (!popover.contains(e.target as Node)) dispose();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") dispose();
  };

  editItem.addEventListener("click", () => {
    dispose();
    void promptEditStartupCmd(opts);
  });

  document.body.append(popover);
  clampPopoverToViewport(popover);
  window.addEventListener("mousedown", onOutside, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", dispose);
  window.addEventListener("scroll", dispose, true);

  return { dispose };
}

async function promptEditStartupCmd(opts: PaneMenuOptions): Promise<void> {
  const current = opts.getStartupCmd() ?? "";
  const next = await promptModal({
    title: "Edit startup command",
    message:
      "Runs once on the next spawn of this terminal. Leave empty to clear. Changes do not re-execute in the live pane.",
    placeholder: "e.g. pnpm dev",
    initialValue: current,
    confirmLabel: "Save",
  });
  if (next === null) return;
  const trimmed = next.trim();
  opts.onChangeStartupCmd(trimmed.length === 0 ? undefined : trimmed);
}

export interface CliRespawnMenuOptions {
  trigger: HTMLElement;
  getCurrentCliId(): string;
  onSelect(cliId: string): void;
}

/**
 * Badge popover that lets the user pick a different CLI for this pane.
 * Mirrors `openPaneMenu`'s lifecycle: closes on outside-click, Escape,
 * scroll, resize. The current cliId is shown as `.is-active` and clicking
 * it is a no-op (baked decision: click on already-active = no-op).
 */
export function openCliRespawnMenu(opts: CliRespawnMenuOptions): PaneMenuHandle {
  document.querySelectorAll(".pane-menu-popover").forEach((node) => node.remove());

  const popover = document.createElement("div");
  popover.className = "pane-menu-popover";
  const rect = opts.trigger.getBoundingClientRect();
  popover.style.position = "fixed";
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.left = `${Math.max(8, rect.left)}px`;

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    popover.remove();
    window.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", dispose);
    window.removeEventListener("scroll", dispose, true);
  };
  const onOutside = (e: MouseEvent): void => {
    if (!popover.contains(e.target as Node)) dispose();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") dispose();
  };

  const current = opts.getCurrentCliId();
  const onSelect = (cliId: string): void => opts.onSelect(cliId);
  for (const profile of ALL_PROFILES) {
    popover.append(createRespawnItem(profile, current, dispose, onSelect));
  }

  document.body.append(popover);
  clampPopoverToViewport(popover);
  window.addEventListener("mousedown", onOutside, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", dispose);
  window.addEventListener("scroll", dispose, true);

  return { dispose };
}

function createRespawnItem(
  profile: CliProfile,
  currentCliId: string,
  dispose: () => void,
  onSelect: (cliId: string) => void,
): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = `pane-menu-item pane-badge--${profile.id}`;
  if (profile.id === currentCliId) item.classList.add("is-active");
  item.textContent = profile.label;
  item.addEventListener("click", () => {
    dispose();
    if (profile.id === currentCliId) return;
    onSelect(profile.id);
  });
  return item;
}

export async function confirmRespawn(cliId: string): Promise<boolean> {
  const profile = resolveProfile(cliId);
  return confirmModal({
    title: `Respawn terminal with ${profile.label}?`,
    message: "The current process will be killed and a new one started. Output will be lost.",
    confirmLabel: "Respawn",
    danger: true,
  });
}

export interface TerminalContextMenuOptions {
  at: { x: number; y: number };
  hasSelection(): boolean;
  onCopy(): void;
  onPaste(): void;
  onClose?(): void;
  onCopySelection?(): void;
  commandActions?: {
    command: string;
    output: string | null;
    onCopyCommand(): void;
    onCopyOutput(): void;
  };
}

let activeTerminalMenuDispose: (() => void) | null = null;

// Right-click menu for the terminal body. Replaces the webview's native menu,
// which in WebKitGTK can activate Paste on the same right-click gesture.
export function openTerminalContextMenu(opts: TerminalContextMenuOptions): PaneMenuHandle {
  activeTerminalMenuDispose?.();
  document.querySelectorAll(".pane-menu-popover").forEach((node) => node.remove());

  const popover = document.createElement("div");
  popover.className = "pane-menu-popover";
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", "Terminal clipboard");
  popover.style.position = "fixed";
  popover.style.top = `${opts.at.y + 2}px`;
  popover.style.left = `${opts.at.x + 2}px`;

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    popover.remove();
    window.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", dispose);
    window.removeEventListener("scroll", dispose, true);
    if (activeTerminalMenuDispose === dispose) activeTerminalMenuDispose = null;
    opts.onClose?.();
  };
  const onOutside = (e: MouseEvent): void => {
    if (!popover.contains(e.target as Node)) dispose();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dispose();
    }
    if (e.key === "Tab") dispose();
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const items = [...popover.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const copyItem = document.createElement("button");
  copyItem.type = "button";
  copyItem.className = "pane-menu-item";
  copyItem.textContent = "Copy";
  copyItem.disabled = !opts.hasSelection();
  copyItem.addEventListener("click", () => {
    dispose();
    opts.onCopy();
  });

  const pasteItem = document.createElement("button");
  pasteItem.type = "button";
  pasteItem.className = "pane-menu-item";
  pasteItem.textContent = "Paste";
  pasteItem.addEventListener("click", () => {
    dispose();
    opts.onPaste();
  });

  popover.append(copyItem);
  const actions = opts.commandActions;
  const isMac = isMacPlatform();
  if (actions) {
    for (const [label, text, shortcut, action] of [
      [
        "Copy command",
        actions.command,
        isMac ? "⇧⌘C" : "Ctrl+Alt+C",
        () => actions.onCopyCommand(),
      ],
      [
        "Copy output",
        actions.output,
        isMac ? "⌥⇧⌘C" : "Ctrl+Alt+Shift+C",
        () => actions.onCopyOutput(),
      ],
    ] as const) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "pane-menu-item";
      item.textContent = label;
      item.disabled = !text;
      item.title = text ? label : "Requires captured shell command/output";
      item.addEventListener("click", () => {
        dispose();
        action();
      });
      const hint = document.createElement("kbd");
      hint.textContent = shortcut;
      item.append(hint);
      item.setAttribute("aria-label", label);
      popover.append(item);
    }
  }
  if (opts.onCopySelection) {
    const selectionItem = document.createElement("button");
    selectionItem.type = "button";
    selectionItem.className = "pane-menu-item";
    selectionItem.textContent = "Copy selection";
    selectionItem.setAttribute("aria-label", "Copy selection");
    selectionItem.addEventListener("click", () => {
      dispose();
      opts.onCopySelection?.();
    });
    popover.append(selectionItem);
  }
  popover.append(pasteItem);
  for (const item of [copyItem, pasteItem]) item.setAttribute("aria-label", item.textContent!);
  for (const item of popover.querySelectorAll("button")) item.setAttribute("role", "menuitem");
  document.body.append(popover);
  clampPopoverToViewport(popover);
  window.addEventListener("mousedown", onOutside, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", dispose);
  window.addEventListener("scroll", dispose, true);
  activeTerminalMenuDispose = dispose;
  popover.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();

  return { dispose };
}

export type { StartupCmdEditCallbacks };

const DOCK_MENU_ITEMS: ReadonlyArray<readonly [TerminalDockPosition, string]> = [
  ["top", "Dock at top"],
  ["right", "Dock at right"],
  ["bottom", "Dock at bottom"],
  ["left", "Dock at left"],
];

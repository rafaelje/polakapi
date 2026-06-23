import { promptModal } from "../../shared/ui/modal";
import type { StartupCmdEditCallbacks } from "./terminal-pane-types";

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

export type { StartupCmdEditCallbacks };

import type { TerminalDockPosition } from "./terminal-layout";

const DRAG_THRESHOLD_PX = 6;
const INTERACTIVE_SELECTOR = "button, a, input, textarea, select, [data-no-dock]";

export interface TerminalDockingOptions {
  handle: HTMLElement;
  grid: HTMLElement;
  paneId: string;
  onDock(sourceId: string, targetId: string, position: TerminalDockPosition): void;
}

export interface TerminalDockingHandle {
  dispose(): void;
}

export function attachTerminalDocking(options: TerminalDockingOptions): TerminalDockingHandle {
  let start: { x: number; y: number } | null = null;
  let active = false;
  let targetId: string | null = null;
  let position: TerminalDockPosition | null = null;
  let overlay: HTMLElement | null = null;

  const clearOverlay = (): void => {
    overlay?.remove();
    overlay = null;
    targetId = null;
    position = null;
  };

  const finish = (): void => {
    start = null;
    active = false;
    options.handle.classList.remove("terminal-drag-handle--active");
    document.body.classList.remove("terminal-pane-dragging");
    clearOverlay();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(INTERACTIVE_SELECTOR)) return;
    start = { x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!start) return;
    if (!active) {
      const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (distance < DRAG_THRESHOLD_PX) return;
      active = true;
      options.handle.classList.add("terminal-drag-handle--active");
      document.body.classList.add("terminal-pane-dragging");
    }
    event.preventDefault();
    const pane = paneAtPoint(options.grid, event.clientX, event.clientY);
    const nextTargetId = pane?.dataset.ptyId ?? null;
    if (!pane || !nextTargetId || nextTargetId === options.paneId) {
      clearOverlay();
      return;
    }
    const nextPosition = resolveTerminalDockPosition(
      pane.getBoundingClientRect(),
      event.clientX,
      event.clientY,
    );
    if (!nextPosition) {
      clearOverlay();
      return;
    }
    targetId = nextTargetId;
    position = nextPosition;
    overlay = renderDockOverlay(overlay, pane.getBoundingClientRect(), nextPosition);
  };

  const onPointerUp = (): void => {
    const dropTargetId = targetId;
    const dropPosition = position;
    const wasActive = active;
    finish();
    if (wasActive && dropTargetId && dropPosition) {
      options.onDock(options.paneId, dropTargetId, dropPosition);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !start) return;
    event.preventDefault();
    finish();
  };

  options.handle.classList.add("terminal-drag-handle");
  options.handle.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", finish);

  return {
    dispose(): void {
      finish();
      options.handle.classList.remove("terminal-drag-handle");
      options.handle.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", finish);
    },
  };
}

export function resolveTerminalDockPosition(
  rect: Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">,
  x: number,
  y: number,
): TerminalDockPosition | null {
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const distances: Array<[TerminalDockPosition, number]> = [
    ["top", (y - rect.top) / height],
    ["bottom", (rect.bottom - y) / height],
    ["left", (x - rect.left) / width],
    ["right", (rect.right - x) / width],
  ];
  distances.sort((left, right) => left[1] - right[1]);
  return distances[0][0];
}

function paneAtPoint(grid: HTMLElement, x: number, y: number): HTMLElement | null {
  const element = document.elementFromPoint(x, y);
  if (!element || !grid.contains(element)) return null;
  return element.closest<HTMLElement>(".pane[data-pty-id]");
}

function renderDockOverlay(
  current: HTMLElement | null,
  rect: DOMRect,
  activePosition: TerminalDockPosition,
): HTMLElement {
  const overlay = current ?? document.createElement("div");
  overlay.className = "terminal-dock-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.left = `${rect.left}px`;
  overlay.style.top = `${rect.top}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  overlay.replaceChildren();
  const preview = document.createElement("div");
  preview.className = `terminal-dock-preview terminal-dock-preview--${activePosition}`;
  overlay.append(preview);
  for (const dockPosition of ["top", "right", "bottom", "left"] as const) {
    const zone = document.createElement("div");
    zone.className = `terminal-dock-zone terminal-dock-zone--${dockPosition}`;
    zone.classList.toggle("is-active", dockPosition === activePosition);
    zone.dataset.dockPosition = dockPosition;
    zone.textContent = DOCK_ARROWS[dockPosition];
    overlay.append(zone);
  }
  if (!current) document.body.append(overlay);
  return overlay;
}

const DOCK_ARROWS: Record<TerminalDockPosition, string> = {
  top: "↑",
  right: "→",
  bottom: "↓",
  left: "←",
};

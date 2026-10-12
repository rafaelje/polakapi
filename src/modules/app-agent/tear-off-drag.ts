import { isOutsideViewport } from "../terminal/terminal-docking";

const DRAG_THRESHOLD_PX = 6;
const INTERACTIVE_SELECTOR = "input, textarea, select, [data-no-drag]";

export interface TearOffDragHandle {
  dispose(): void;
}

/**
 * Dragging `handle` past the window edge and releasing there calls
 * `onTearOff` with the pointer's screen coordinates. A plain click still
 * reaches the handle: the drag only starts past a few pixels.
 */
export function attachTearOffDrag(
  handle: HTMLElement,
  onTearOff: (screenX: number, screenY: number) => void,
): TearOffDragHandle {
  let start: { x: number; y: number } | null = null;
  let active = false;
  let pointerId: number | null = null;

  const finish = (): void => {
    start = null;
    active = false;
    handle.classList.remove("tear-off-handle--active", "tear-off-handle--outside");
    document.body.classList.remove("terminal-pane-dragging");
    if (pointerId !== null && handle.hasPointerCapture?.(pointerId)) {
      handle.releasePointerCapture(pointerId);
    }
    pointerId = null;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(INTERACTIVE_SELECTOR)) return;
    start = { x: event.clientX, y: event.clientY };
    pointerId = event.pointerId;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!start) return;
    if (!active) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD_PX) return;
      active = true;
      handle.classList.add("tear-off-handle--active");
      document.body.classList.add("terminal-pane-dragging");
      // Keeps the pointer events coming once it leaves the window.
      if (pointerId !== null) handle.setPointerCapture?.(pointerId);
    }
    event.preventDefault();
    handle.classList.toggle(
      "tear-off-handle--outside",
      isOutsideViewport(event.clientX, event.clientY),
    );
  };

  const onPointerUp = (event: PointerEvent): void => {
    const tearOff = active && isOutsideViewport(event.clientX, event.clientY);
    const wasActive = active;
    finish();
    if (tearOff) onTearOff(event.screenX, event.screenY);
    // A drag that ends inside the window is not a click.
    if (wasActive) {
      handle.addEventListener("click", swallowClick, { capture: true, once: true });
      setTimeout(() => handle.removeEventListener("click", swallowClick, { capture: true }), 0);
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !start) return;
    event.preventDefault();
    finish();
  };

  handle.classList.add("tear-off-handle");
  handle.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", finish);

  return {
    dispose(): void {
      finish();
      handle.classList.remove("tear-off-handle");
      handle.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", finish);
    },
  };
}

function swallowClick(event: Event): void {
  event.stopPropagation();
  event.preventDefault();
}

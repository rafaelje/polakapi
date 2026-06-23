import { makeFlexGutter } from "../layout/gutters";
import type { TerminalPane } from "./terminal-pane";

/**
 * Arranges live `TerminalPane` elements inside `grid` in row-major order,
 * inserting flex gutters between siblings so the user can resize columns and
 * rows interactively. The function is pure DOM — it never spawns, disposes or
 * mutates panes; it only re-parents their root elements.
 *
 * After re-parenting, `refit()` is queued for the next animation frame so
 * xterm picks up the new container size once the browser has applied layout.
 */
export function layoutTerminalGrid(
  grid: HTMLElement,
  order: string[],
  panes: Map<string, TerminalPane>,
  cols: number,
  refit: () => void,
): void {
  for (const id of order) {
    const p = panes.get(id);
    p?.el.parentElement?.removeChild(p.el);
  }
  grid.innerHTML = "";
  for (let i = 0; i < order.length; i += cols) {
    if (i > 0) grid.append(makeFlexGutter("v", refit));
    const row = document.createElement("div");
    row.className = "grid-row";
    order.slice(i, i + cols).forEach((id, idx) => {
      const pane = panes.get(id);
      if (!pane) return;
      pane.el.style.flex = "1 1 0";
      if (idx > 0) row.append(makeFlexGutter("h", refit));
      row.append(pane.el);
    });
    grid.append(row);
  }
  requestAnimationFrame(refit);
}

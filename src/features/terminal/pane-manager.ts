import { makeFlexGutter } from "../layout/layout";
import { TerminalPane, type PaneCreateOptions } from "./terminal-pane";

export interface PaneManagerOptions {
  /** Element that hosts the grid of rows of panes. */
  gridEl: HTMLElement;
  /** Initial number of columns per row. Must be >= 1. */
  gridCols: number;
}

/**
 * Owns the lifecycle of every TerminalPane: creation, focus, ordering, layout
 * and disposal. Exposes a small surface so `main.ts` is wiring only, not state.
 */
export class PaneManager {
  private readonly panes = new Map<string, TerminalPane>();
  private readonly order: string[] = [];
  private focusedId: string | null = null;
  private readonly gridEl: HTMLElement;
  private cols: number;

  constructor(opts: PaneManagerOptions) {
    this.gridEl = opts.gridEl;
    this.cols = Math.max(1, Math.floor(opts.gridCols));
  }

  get size(): number {
    return this.order.length;
  }

  get focusedPaneId(): string | null {
    return this.focusedId;
  }

  get gridCols(): number {
    return this.cols;
  }

  setGridCols(cols: number): void {
    const next = Math.max(1, Math.floor(cols));
    if (next === this.cols) return;
    this.cols = next;
    this.relayout();
  }

  ids(): string[] {
    return [...this.order];
  }

  get(id: string): TerminalPane | undefined {
    return this.panes.get(id);
  }

  refit(): void {
    for (const pane of this.panes.values()) pane.fit();
  }

  async create(opts?: PaneCreateOptions): Promise<TerminalPane | null> {
    const pane = new TerminalPane();
    pane.el.style.visibility = "hidden";

    try {
      await pane.attach(this.gridEl, opts);
    } catch (error) {
      console.error("Failed to create terminal pane", error);
      await pane.dispose();
      return null;
    }

    pane.el.style.visibility = "";
    this.panes.set(pane.ptyId, pane);
    this.order.push(pane.ptyId);

    pane.el.addEventListener("mousedown", () => this.setFocus(pane.ptyId));
    pane.bodyEl.addEventListener("focusin", () => this.setFocus(pane.ptyId));
    pane.closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.close(pane.ptyId);
    });

    this.setFocus(pane.ptyId);
    this.relayout();
    return pane;
  }

  async close(ptyId: string): Promise<void> {
    const pane = this.panes.get(ptyId);
    if (!pane) return;
    this.panes.delete(ptyId);
    const idx = this.order.indexOf(ptyId);
    if (idx >= 0) this.order.splice(idx, 1);
    if (this.focusedId === ptyId) {
      this.focusedId = this.order[Math.max(0, idx - 1)] ?? null;
      if (this.focusedId) this.setFocus(this.focusedId, true);
    }
    await pane.dispose();
    this.relayout();
  }

  closeFocused(): void {
    if (this.focusedId) void this.close(this.focusedId);
  }

  setFocus(ptyId: string, focusTerm = false): void {
    this.focusedId = ptyId;
    for (const pane of this.panes.values()) {
      pane.el.classList.toggle("focused", pane.ptyId === ptyId);
    }
    if (focusTerm) this.panes.get(ptyId)?.focus();
  }

  focusByIndex(idx: number): void {
    const id = this.order[idx];
    if (id) this.setFocus(id, true);
  }

  focusRelative(delta: 1 | -1): void {
    if (this.order.length === 0) return;
    const currentIdx = this.focusedId ? this.order.indexOf(this.focusedId) : -1;
    const next = (currentIdx + delta + this.order.length) % this.order.length;
    this.focusByIndex(next);
  }

  private relayout(): void {
    for (const id of this.order) {
      const p = this.panes.get(id);
      p?.el.parentElement?.removeChild(p.el);
    }
    this.gridEl.innerHTML = "";
    const refit = (): void => this.refit();
    for (let i = 0; i < this.order.length; i += this.cols) {
      if (i > 0) this.gridEl.append(makeFlexGutter("v", refit));
      const row = document.createElement("div");
      row.className = "grid-row";
      this.order.slice(i, i + this.cols).forEach((id, idx) => {
        const pane = this.panes.get(id);
        if (!pane) return;
        pane.el.style.flex = "1 1 0";
        if (idx > 0) row.append(makeFlexGutter("h", refit));
        row.append(pane.el);
      });
      this.gridEl.append(row);
    }
    requestAnimationFrame(refit);
  }
}

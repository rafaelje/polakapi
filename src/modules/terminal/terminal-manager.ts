import type { ProjectId } from "../workspaces/types";
import { layoutTerminalGrid } from "./terminal-grid-layout";
import { TerminalPane } from "./terminal-pane";
import { type TerminalSpec } from "./types";

export interface TerminalManagerOptions {
  /** Identity used for router lookup + events. */
  projectId: ProjectId;
  /** project.path applied when a spec omits cwd. */
  defaultCwd: string;
  /** Initial number of columns per row. Must be >= 1. */
  gridCols: number;
}

export type TerminalManagerEvent =
  | { type: "count-changed"; projectId: ProjectId; count: number }
  | { type: "spec-changed"; projectId: ProjectId; specs: TerminalSpec[] };

export type TerminalManagerListener = (event: TerminalManagerEvent) => void;

/**
 * Owns the lifecycle of every TerminalPane for a single project: creation,
 * focus, ordering, layout and disposal. The router parents `gridEl` into the
 * active host on mount and pulls it out on unmount; the node itself never
 * changes identity for the manager's lifetime.
 */
export class TerminalManager {
  private readonly panes = new Map<string, TerminalPane>();
  private readonly order: string[] = [];
  private readonly specsById = new Map<string, TerminalSpec>();
  private focusedId: string | null = null;
  private readonly grid: HTMLElement;
  private cols: number;
  private defaultCwd: string;
  private readonly listeners = new Set<TerminalManagerListener>();
  private suppressSpecEvent = false;
  readonly projectId: ProjectId;

  constructor(opts: TerminalManagerOptions) {
    this.projectId = opts.projectId;
    this.defaultCwd = opts.defaultCwd;
    this.cols = Math.max(1, Math.floor(opts.gridCols));
    const grid = document.createElement("div");
    grid.className = "terminal-grid";
    this.grid = grid;
  }

  get gridEl(): HTMLElement {
    return this.grid;
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

  setDefaultCwd(cwd: string): void {
    this.defaultCwd = cwd;
  }

  ids(): string[] {
    return [...this.order];
  }

  specs(): TerminalSpec[] {
    return this.order
      .map((id) => this.specsById.get(id))
      .filter((spec): spec is TerminalSpec => spec !== undefined);
  }

  get(id: string): TerminalPane | undefined {
    return this.panes.get(id);
  }

  refit(): void {
    for (const pane of this.panes.values()) pane.fit();
  }

  on(listener: TerminalManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Spawn a pane backed by the given spec. When `spec.cwd` is undefined the
   * manager substitutes `defaultCwd` (the owning project's path).
   */
  async addPane(spec?: Partial<TerminalSpec>): Promise<TerminalPane | null> {
    const pane = new TerminalPane();
    pane.el.style.visibility = "hidden";

    const cwd = spec?.cwd ?? this.defaultCwd;
    try {
      await pane.attach(this.grid, { cwd });
    } catch (error) {
      console.error("Failed to create terminal pane", error);
      await pane.dispose();
      return null;
    }

    pane.el.style.visibility = "";
    const ptyId = pane.ptyId;
    const finalSpec: TerminalSpec = {
      id: ptyId,
      title: spec?.title,
      cwd: spec?.cwd,
      startupCmd: spec?.startupCmd,
    };
    this.panes.set(ptyId, pane);
    this.order.push(ptyId);
    this.specsById.set(ptyId, finalSpec);

    pane.el.addEventListener("mousedown", () => this.setFocus(ptyId));
    pane.bodyEl.addEventListener("focusin", () => this.setFocus(ptyId));
    pane.closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.close(ptyId);
    });

    this.setFocus(ptyId);
    this.relayout();
    this.emitCount();
    this.emitSpecs();
    return pane;
  }

  /** Backward-compat alias used by code paths that have not migrated yet. */
  create(): Promise<TerminalPane | null> {
    return this.addPane();
  }

  async close(ptyId: string): Promise<void> {
    const pane = this.panes.get(ptyId);
    if (!pane) return;
    this.panes.delete(ptyId);
    this.specsById.delete(ptyId);
    const idx = this.order.indexOf(ptyId);
    if (idx >= 0) this.order.splice(idx, 1);
    if (this.focusedId === ptyId) {
      this.focusedId = this.order[Math.max(0, idx - 1)] ?? null;
      if (this.focusedId) this.setFocus(this.focusedId, true);
    }
    await pane.dispose();
    this.relayout();
    this.emitCount();
    this.emitSpecs();
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

  /** Tears down every PTY + xterm and removes gridEl from any parent. */
  async dispose(): Promise<void> {
    this.listeners.clear();
    const toClose = [...this.panes.values()];
    this.panes.clear();
    this.specsById.clear();
    this.order.splice(0);
    this.focusedId = null;
    await Promise.all(toClose.map((p) => p.dispose().catch(() => undefined)));
    this.grid.remove();
  }

  /**
   * Replays an array of specs as live panes. Suppresses per-pane spec-changed
   * events and emits a single one at the end so persistence writes are not
   * amplified.
   */
  async restoreSpecs(specs: TerminalSpec[]): Promise<void> {
    if (specs.length === 0) return;
    this.suppressSpecEvent = true;
    try {
      for (const spec of specs) {
        await this.addPane(spec);
      }
    } finally {
      this.suppressSpecEvent = false;
    }
    this.emitSpecs();
  }

  private relayout(): void {
    layoutTerminalGrid(this.grid, this.order, this.panes, this.cols, () => this.refit());
  }

  private emitCount(): void {
    this.emit({
      type: "count-changed",
      projectId: this.projectId,
      count: this.order.length,
    });
  }

  private emitSpecs(): void {
    if (this.suppressSpecEvent) return;
    this.emit({
      type: "spec-changed",
      projectId: this.projectId,
      specs: this.specs(),
    });
  }

  private emit(event: TerminalManagerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("TerminalManager listener threw", error);
      }
    }
  }
}

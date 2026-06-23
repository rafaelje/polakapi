import {
  TerminalManager,
  type NotificationContext,
  type TerminalManagerEvent,
} from "../modules/terminal/terminal-manager";
import type { TerminalPane } from "../modules/terminal/terminal-pane";
import type { TerminalSpec } from "../modules/terminal/types";
import { ptyKill } from "../modules/terminal/pty-client";
import type { Project, ProjectId } from "../modules/workspaces/types";

export type TerminalRouterEvent =
  | { type: "counts-changed"; counts: ReadonlyMap<ProjectId, number> }
  | { type: "bell-pending"; projectId: ProjectId; paneId: string; pending: boolean };

export type TerminalRouterListener = (event: TerminalRouterEvent) => void;

export interface TerminalRouterOptions {
  onPersistSpecs(projectId: ProjectId, specs: TerminalSpec[]): void;
}

const DEFAULT_GRID_COLS = 2;

/**
 * Owns one TerminalManager per ProjectId. Manages mount/unmount via DOM
 * reparenting — never disposes panes or PTYs on hide. Aggregates pane counts
 * across all projects and emits `counts-changed` for the sidebar badges.
 *
 * Concurrency: mount() captures a monotonic token so a rapid project switch
 * cannot let a previous mount's deferred refit fire against a host that has
 * already been re-detached.
 */
export class TerminalRouter {
  private readonly managers = new Map<ProjectId, TerminalManager>();
  private readonly unsubscribes = new Map<ProjectId, () => void>();
  private readonly listeners = new Set<TerminalRouterListener>();
  private activeProjectId: ProjectId | null = null;
  private activeHost: HTMLElement | null = null;
  private mountToken = 0;
  private notificationContext: NotificationContext | null = null;

  constructor(private readonly opts: TerminalRouterOptions) {}

  /**
   * F5: late-bind a notification context that every existing AND future
   * TerminalManager will use. Applied retroactively to the managers map so a
   * manager created during boot (before workspaces-bootstrap had a chance to
   * wire window-focus state) still picks up bell wiring on the next addPane.
   */
  setNotificationContext(ctx: NotificationContext | null): void {
    this.notificationContext = ctx;
    for (const manager of this.managers.values()) manager.setNotificationContext(ctx);
  }

  getOrCreate(project: Project): TerminalManager {
    const existing = this.managers.get(project.id);
    if (existing) return existing;
    const manager = new TerminalManager({
      projectId: project.id,
      defaultCwd: project.path,
      gridCols: DEFAULT_GRID_COLS,
      activeCliId: project.activeCliId,
      notificationContext: this.notificationContext ?? undefined,
    });
    this.managers.set(project.id, manager);
    const unsubscribe = manager.on((event) => this.onManagerEvent(event));
    this.unsubscribes.set(project.id, unsubscribe);
    this.emitCounts();
    return manager;
  }

  /**
   * Parents the manager's gridEl into `hostEl`, then refits every pane once
   * the browser has measured the new host (rAF). The first refit reads the
   * fresh size; we schedule a second one for the next frame so the xterm
   * picks up any ResizeObserver-driven adjustment.
   */
  mount(projectId: ProjectId, hostEl: HTMLElement): void {
    const manager = this.managers.get(projectId);
    if (!manager) return;
    if (this.activeProjectId === projectId && manager.gridEl.parentElement === hostEl) {
      return; // Idempotent: already mounted in the same host.
    }
    this.unmount();
    hostEl.appendChild(manager.gridEl);
    this.activeProjectId = projectId;
    this.activeHost = hostEl;
    const token = ++this.mountToken;
    const refitIfStillMine = (): void => {
      if (token !== this.mountToken) return;
      const m = this.managers.get(projectId);
      if (!m || m.gridEl.parentElement !== hostEl) return;
      m.refit();
    };
    requestAnimationFrame(() => {
      refitIfStillMine();
      requestAnimationFrame(refitIfStillMine);
    });
  }

  unmount(): void {
    if (!this.activeProjectId) return;
    const manager = this.managers.get(this.activeProjectId);
    manager?.gridEl.remove();
    this.activeProjectId = null;
    this.activeHost = null;
    this.mountToken++;
  }

  getActive(): TerminalManager | null {
    if (!this.activeProjectId) return null;
    return this.managers.get(this.activeProjectId) ?? null;
  }

  getActiveHost(): HTMLElement | null {
    return this.activeHost;
  }

  getById(projectId: ProjectId): TerminalManager | null {
    return this.managers.get(projectId) ?? null;
  }

  findPaneById(ptyId: string): { manager: TerminalManager; pane: TerminalPane } | null {
    for (const manager of this.managers.values()) {
      const pane = manager.get(ptyId);
      if (pane) return { manager, pane };
    }
    return null;
  }

  liveCountsByProject(): ReadonlyMap<ProjectId, number> {
    const map = new Map<ProjectId, number>();
    for (const [id, manager] of this.managers) map.set(id, manager.size);
    return map;
  }

  getCount(projectId: ProjectId): number {
    return this.managers.get(projectId)?.size ?? 0;
  }

  totalLiveCount(): number {
    let total = 0;
    for (const manager of this.managers.values()) total += manager.size;
    return total;
  }

  allPaneIds(): string[] {
    const ids: string[] = [];
    for (const manager of this.managers.values()) ids.push(...manager.ids());
    return ids;
  }

  onProjectPathChanged(projectId: ProjectId, newPath: string): void {
    this.managers.get(projectId)?.setDefaultCwd(newPath);
  }

  on(listener: TerminalRouterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Kills every PTY of `projectId`, removes its gridEl from the DOM, drops
   * the manager from the map. Only legitimate caller is the project-delete
   * flow in workspaces-bootstrap.
   */
  async dispose(projectId: ProjectId): Promise<void> {
    const manager = this.managers.get(projectId);
    if (!manager) return;
    if (this.activeProjectId === projectId) {
      this.activeProjectId = null;
      this.activeHost = null;
      this.mountToken++;
    }
    const unsubscribe = this.unsubscribes.get(projectId);
    unsubscribe?.();
    this.unsubscribes.delete(projectId);
    this.managers.delete(projectId);
    await manager.dispose();
    this.emitCounts();
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.managers.keys()];
    // Kill ptys eagerly so the backend tears down even if a manager throws.
    for (const manager of this.managers.values()) {
      for (const id of manager.ids()) void ptyKill(id);
    }
    await Promise.all(ids.map((id) => this.dispose(id)));
  }

  private onManagerEvent(event: TerminalManagerEvent): void {
    if (event.type === "count-changed") {
      this.emitCounts();
    } else if (event.type === "spec-changed") {
      this.opts.onPersistSpecs(event.projectId, event.specs);
    } else if (event.type === "bell-pending") {
      this.emit({
        type: "bell-pending",
        projectId: event.projectId,
        paneId: event.paneId,
        pending: event.pending,
      });
    }
  }

  private emitCounts(): void {
    this.emit({ type: "counts-changed", counts: this.liveCountsByProject() });
  }

  private emit(event: TerminalRouterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("TerminalRouter listener threw", error);
      }
    }
  }
}

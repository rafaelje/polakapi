import {
  TerminalManager,
  type NotificationContext,
  type TerminalManagerEvent,
} from "../modules/terminal/terminal-manager";
import type { TerminalPane } from "../modules/terminal/terminal-pane";
import { repairTerminalLayout, type TerminalLayoutNode } from "../modules/terminal/terminal-layout";
import type { PaneSnapshot, PaneSnapshots, TerminalSpec } from "../modules/terminal/types";
import { snapshotPanes } from "../modules/terminal/pane-snapshots";
import { paneWindowId } from "../modules/project-window/protocol";
import { ptyKill } from "../modules/terminal/pty-client";
import {
  ProjectActivityTracker,
  type ProjectActivityState,
} from "../modules/terminal/project-activity";
import type { Project, ProjectId } from "../modules/workspaces/state/types";

export type TerminalRouterEvent =
  | { type: "counts-changed"; counts: ReadonlyMap<ProjectId, number> }
  | { type: "activity-changed"; projectId: ProjectId; state: ProjectActivityState }
  | { type: "bell-pending"; projectId: ProjectId; paneId: string; pending: boolean };

export type TerminalRouterListener = (event: TerminalRouterEvent) => void;

export interface TerminalRouterOptions {
  onPersistSpecs(projectId: ProjectId, specs: TerminalSpec[]): void;
  onPersistLayout(projectId: ProjectId, layout: TerminalLayoutNode | null): void;
}

/** A project's grid with its PTYs still running, ready to be rendered elsewhere. */
export interface ReleasedGrid {
  specs: TerminalSpec[];
  layout: TerminalLayoutNode | null;
  activeCliId: string;
  /** What each pane showed when it was released, by PTY id. */
  snapshots?: PaneSnapshots;
}

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
  private readonly activity: ProjectActivityTracker;
  /** Live panes in other windows, by window id, so project counts stay whole. */
  private readonly external = new Map<string, { projectId: ProjectId; count: number }>();
  private readonly externalLayouts = new Map<
    string,
    { projectId: ProjectId; layout: TerminalLayoutNode | null }
  >();
  private readonly deleted = new Set<ProjectId>();
  private readonly externalSpecs = new Map<
    string,
    { projectId: ProjectId; specs: TerminalSpec[] }
  >();
  private tearOffHandler:
    | ((projectId: ProjectId, ptyId: string, x: number, y: number) => void)
    | null = null;

  constructor(private readonly opts: TerminalRouterOptions) {
    this.activity = new ProjectActivityTracker({
      getLiveCount: (projectId) => this.getCount(projectId),
      onChange: (projectId, state) => this.emit({ type: "activity-changed", projectId, state }),
    });
  }

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

  /** Called when a pane header is dropped outside the main window. */
  setTearOffHandler(
    handler: ((projectId: ProjectId, ptyId: string, x: number, y: number) => void) | null,
  ): void {
    this.tearOffHandler = handler;
  }

  getOrCreate(project: Project): TerminalManager {
    if (this.deleted.has(project.id)) throw new Error("Project has been deleted");
    const existing = this.managers.get(project.id);
    if (existing) return existing;
    const manager = new TerminalManager({
      projectId: project.id,
      defaultCwd: project.path,
      layout: project.terminalLayout,
      activeCliId: project.activeCliId,
      notificationContext: this.notificationContext ?? undefined,
      onTearOff: (ptyId, x, y) => this.tearOffHandler?.(project.id, ptyId, x, y),
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
    for (const { projectId, count } of this.external.values()) {
      map.set(projectId, (map.get(projectId) ?? 0) + count);
    }
    return map;
  }

  getCount(projectId: ProjectId): number {
    return this.liveCountsByProject().get(projectId) ?? 0;
  }

  setExternalCount(windowId: string, projectId: ProjectId, count: number | null): void {
    if (this.deleted.has(projectId) && count !== null) return;
    if (count === null) this.external.delete(windowId);
    else this.external.set(windowId, { projectId, count });
    this.emitCounts();
    this.activity.refresh(projectId);
  }

  setExternalSpecs(windowId: string, projectId: ProjectId, specs: TerminalSpec[] | null): void {
    if (this.deleted.has(projectId)) return;
    if (specs === null) this.externalSpecs.delete(windowId);
    else this.externalSpecs.set(windowId, { projectId, specs });
    this.persistSpecs(projectId);
  }

  private persistSpecs(projectId: ProjectId): void {
    const specs = new Map<string, TerminalSpec>();
    for (const spec of this.managers.get(projectId)?.specs() ?? []) specs.set(spec.id, spec);
    for (const entry of this.externalSpecs.values()) {
      if (entry.projectId === projectId) for (const spec of entry.specs) specs.set(spec.id, spec);
    }
    this.opts.onPersistSpecs(projectId, [...specs.values()]);
    this.persistLayout(projectId);
  }

  setExternalLayout(
    windowId: string,
    projectId: ProjectId,
    layout: TerminalLayoutNode | null,
  ): void {
    if (this.deleted.has(projectId)) return;
    this.externalLayouts.set(windowId, { projectId, layout });
    this.persistLayout(projectId);
  }

  private persistLayout(projectId: ProjectId): void {
    let layout = this.managers.get(projectId)?.layoutSnapshot ?? null;
    if (!layout) layout = this.externalLayouts.get(projectId)?.layout ?? null;
    const ids = [...(this.managers.get(projectId)?.specs() ?? []).map((spec) => spec.id)];
    for (const entry of this.externalSpecs.values()) {
      if (entry.projectId === projectId) ids.push(...entry.specs.map((spec) => spec.id));
    }
    this.opts.onPersistLayout(projectId, repairTerminalLayout(layout, ids));
  }

  /** Takes one pane out of a project's grid, leaving its process running. */
  async tearOff(
    projectId: ProjectId,
    ptyId: string,
  ): Promise<{ spec: TerminalSpec; snapshot: PaneSnapshot | null } | null> {
    const manager = this.managers.get(projectId);
    if (!manager || !(await manager.freeze())) return null;
    try {
      const spec = manager.specs().find((candidate) => candidate.id === ptyId);
      if (!spec) return null;
      const snapshot = (await manager.get(ptyId)?.snapshot()) ?? null;
      if (this.managers.get(projectId) !== manager) return null;
      this.setExternalSpecs(paneWindowId(projectId, ptyId), projectId, [spec]);
      await manager.close(ptyId, { keepPty: true });
      return { spec, snapshot };
    } finally {
      manager.thaw();
    }
  }

  /** Puts running panes back into a project's grid that is already here. */
  async adoptPanes(
    projectId: ProjectId,
    specs: TerminalSpec[],
    snapshots?: PaneSnapshots,
  ): Promise<boolean> {
    await this.managers.get(projectId)?.waitForHandoff();
    const manager = this.managers.get(projectId);
    if (!manager || this.deleted.has(projectId)) return false;
    for (const spec of specs) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await manager.addPane(spec, {
        adoptPtyId: spec.id,
        skipStartupCmd: true,
        snapshot: snapshots?.[spec.id],
      });
    }
    return true;
  }

  /**
   * Hands a project's grid over: the panes stop rendering here, the PTYs keep
   * running, and what another window needs to rebuild the grid comes back.
   */
  async release(projectId: ProjectId): Promise<ReleasedGrid | null> {
    const manager = this.managers.get(projectId);
    if (!manager || !(await manager.freeze())) return null;
    const grid: ReleasedGrid = {
      specs: manager.specs(),
      layout: manager.layoutSnapshot,
      activeCliId: manager.getActiveCli(),
      snapshots: await snapshotPanes(manager),
    };
    if (this.managers.get(projectId) !== manager) return null;
    this.setExternalLayout(projectId, projectId, grid.layout);
    this.setExternalSpecs(projectId, projectId, grid.specs);
    if (this.activeProjectId === projectId) this.unmount();
    this.unsubscribes.get(projectId)?.();
    this.unsubscribes.delete(projectId);
    this.managers.delete(projectId);
    await manager.dispose({ keepPty: true });
    this.emitCounts();
    return grid;
  }

  /** The reverse of `release`: renders PTYs that are already running. */
  async adopt(project: Project, grid: ReleasedGrid): Promise<TerminalManager> {
    await this.managers.get(project.id)?.waitForHandoff();
    const manager = this.getOrCreate({
      ...project,
      terminalLayout: grid.layout ?? undefined,
      activeCliId: grid.activeCliId,
    });
    await manager.restoreSpecs(grid.specs, { adopt: true, snapshots: grid.snapshots });
    return manager;
  }

  getActivity(projectId: ProjectId): ProjectActivityState {
    return this.activity.get(projectId);
  }

  recordActivity(ptyId: string): void {
    const found = this.findPaneById(ptyId);
    if (found) this.activity.record(found.manager.projectId, ptyId);
  }

  getSuspendedCount(projectId: ProjectId): number {
    return this.managers.get(projectId)?.suspendedCount ?? 0;
  }

  totalLiveCount(): number {
    let total = 0;
    for (const count of this.liveCountsByProject().values()) total += count;
    return total;
  }

  allPaneIds(): string[] {
    const ids: string[] = [];
    for (const manager of this.managers.values()) ids.push(...manager.ids());
    return ids;
  }

  livePanes(): Array<{
    paneId: string;
    projectId: ProjectId;
    cliId?: string;
    lastActivityAt: number;
    cwd?: string;
    title?: string;
    index: number;
  }> {
    const out: Array<{
      paneId: string;
      projectId: ProjectId;
      cliId?: string;
      lastActivityAt: number;
      cwd?: string;
      title?: string;
      index: number;
    }> = [];
    for (const [projectId, manager] of this.managers) {
      let index = 0;
      for (const spec of manager.specs()) {
        index += 1;
        if (!manager.isLive(spec.id)) continue;
        out.push({
          paneId: spec.id,
          projectId,
          cliId: spec.cliId,
          lastActivityAt: manager.get(spec.id)?.lastActivityAt ?? 0,
          cwd: spec.cwd,
          title: spec.title,
          index,
        });
      }
    }
    return out;
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
    this.deleted.add(projectId);
    const externalIds = new Set<string>();
    for (const [windowId, entry] of this.externalSpecs) {
      if (entry.projectId !== projectId) continue;
      for (const spec of entry.specs) if (!spec.suspended) externalIds.add(spec.id);
      this.externalSpecs.delete(windowId);
      this.externalLayouts.delete(windowId);
      this.external.delete(windowId);
    }
    const killing = Promise.all([...externalIds].map((id) => ptyKill(id)));
    const manager = this.managers.get(projectId);
    if (!manager) {
      await killing;
      this.activity.delete(projectId);
      this.emitCounts();
      return;
    }
    if (this.activeProjectId === projectId) {
      this.activeProjectId = null;
      this.activeHost = null;
      this.mountToken++;
    }
    const unsubscribe = this.unsubscribes.get(projectId);
    unsubscribe?.();
    this.unsubscribes.delete(projectId);
    this.managers.delete(projectId);
    this.activity.delete(projectId);
    await Promise.all([manager.dispose(), killing]);
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
      this.activity.refresh(event.projectId);
    } else if (event.type === "spec-changed") {
      this.persistSpecs(event.projectId);
    } else if (event.type === "layout-changed") {
      this.persistLayout(event.projectId);
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

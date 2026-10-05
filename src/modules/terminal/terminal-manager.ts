import type { LayoutTemplate, ProjectId } from "../workspaces/state/types";
import { replacePaneSlot } from "./terminal-pane-replacement";
import {
  ManagerLifecycle,
  restorePaneSpecs,
  createdPaneSpec,
  patchedPaneSpec,
  errorMessage,
} from "./terminal-manager-lifecycle";
import { resolveProfile } from "./cli-registry";
import { executeTemplatePlan, planTemplateApplication } from "./layout-templates";
import {
  paneBoxes,
  resolveDirectionalFocus,
  type FocusDirection,
} from "./terminal-focus-navigation";
import { confirmRespawn } from "./terminal-pane-menu";
import { type TerminalDockingHandle } from "./terminal-docking";
import {
  appendTerminalPane,
  createDefaultTerminalLayout,
  dockTerminalPane,
  dockTerminalPaneAtRoot,
  removeTerminalPane,
  repairTerminalLayout,
  terminalLayoutPaneIds,
  updateTerminalSplitRatio,
  type TerminalDockPosition,
  type TerminalLayoutNode,
  type TerminalLayoutPath,
} from "./terminal-layout";
import { TerminalPane } from "./terminal-pane";
import { scheduleTerminalWrite, wireTerminalPane } from "./terminal-pane-wiring";
import { shouldReplayShellCommand } from "./resume-whitelist";
import { ptyKill } from "./pty-client";
import {
  registerManagerBell,
  type BellNotificationHandle,
  type NotificationContext,
} from "./terminal-notifications";
import { layoutTerminalSplits } from "./terminal-split-layout";
import { type PaneAddOptions, type PaneSnapshots, type TerminalSpec } from "./types";

export type { NotificationContext };

export interface TerminalManagerOptions {
  projectId: ProjectId;
  /** project.path applied when a spec omits cwd. */
  defaultCwd: string;
  layout?: TerminalLayoutNode;
  /** Default CLI id for new panes; undefined falls back to "shell". */
  activeCliId?: string;
  /** Optional. When omitted, panes do not register bell notifications. */
  notificationContext?: NotificationContext;
  /** A pane's header was dropped outside the window, at these screen coordinates. */
  onTearOff?(this: void, ptyId: string, screenX: number, screenY: number): void;
}

export type TerminalManagerEvent =
  | { type: "count-changed"; projectId: ProjectId; count: number }
  | { type: "spec-changed"; projectId: ProjectId; specs: TerminalSpec[] }
  | { type: "layout-changed"; projectId: ProjectId; layout: TerminalLayoutNode | null }
  | { type: "bell-pending"; projectId: ProjectId; paneId: string; pending: boolean };

export type TerminalManagerListener = (event: TerminalManagerEvent) => void;

export class TerminalManager {
  private readonly panes = new Map<string, TerminalPane>();
  /** Adopted panes still catching up; their live output must reach them too. */
  private readonly adopting = new Map<string, TerminalPane>();
  private readonly order: string[] = [];
  private readonly liveIds = new Set<string>();
  private readonly specsById = new Map<string, TerminalSpec>();
  private focusedId: string | null = null;
  private readonly grid: HTMLElement;
  private layout: TerminalLayoutNode | null = null;
  private initialLayout: TerminalLayoutNode | null;
  private defaultCwd: string;
  private readonly listeners = new Set<TerminalManagerListener>();
  private suppressPersistenceEvents = false;
  private notificationContext: NotificationContext | null;
  private readonly bellHandles = new Map<string, BellNotificationHandle>();
  private readonly dockingHandles = new Map<string, TerminalDockingHandle>();
  private readonly respawning = new Set<string>();
  private activeCliId: string;
  private readonly lifecycle = new ManagerLifecycle();
  freeze(): Promise<boolean> {
    return this.lifecycle.freeze();
  }
  thaw(): void {
    this.lifecycle.thaw();
  }
  waitForHandoff(): Promise<void> {
    return this.lifecycle.waitForHandoff();
  }
  readonly projectId: ProjectId;
  private readonly onTearOff: TerminalManagerOptions["onTearOff"];

  constructor(opts: TerminalManagerOptions) {
    this.projectId = opts.projectId;
    this.defaultCwd = opts.defaultCwd;
    this.initialLayout = opts.layout ?? null;
    this.activeCliId = opts.activeCliId && opts.activeCliId.length > 0 ? opts.activeCliId : "shell";
    this.notificationContext = opts.notificationContext ?? null;
    this.onTearOff = opts.onTearOff;
    const grid = document.createElement("div");
    grid.className = "terminal-grid";
    this.grid = grid;
  }

  setNotificationContext(ctx: NotificationContext | null): void {
    this.notificationContext = ctx;
  }

  updateSpec(terminalId: string, patch: Partial<Omit<TerminalSpec, "id">>): void {
    if (this.lifecycle.disposed || this.lifecycle.frozen) return;
    const current = this.specsById.get(terminalId);
    if (!current) return;
    const next = patchedPaneSpec(current, patch);
    if (next === current) return;
    this.specsById.set(terminalId, next);
    this.emitSpecs();
  }

  get gridEl(): HTMLElement {
    return this.grid;
  }

  get size(): number {
    return this.liveIds.size;
  }

  get suspendedCount(): number {
    let count = 0;
    for (const spec of this.specsById.values()) if (spec.suspended) count++;
    return count;
  }

  get focusedPaneId(): string | null {
    return this.focusedId;
  }

  get layoutSnapshot(): TerminalLayoutNode | null {
    return this.layout;
  }

  setActiveCli(cliId: string): void {
    this.activeCliId = cliId;
  }

  getActiveCli(): string {
    return this.activeCliId;
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
    return this.panes.get(id) ?? this.adopting.get(id);
  }

  isLive(id: string): boolean {
    return this.liveIds.has(id);
  }

  refit(): void {
    for (const pane of this.panes.values()) pane.fit();
  }

  on(listener: TerminalManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async addPane(spec?: Partial<TerminalSpec>, opts?: PaneAddOptions): Promise<TerminalPane | null> {
    if (this.lifecycle.disposed || this.lifecycle.frozen) return null;
    return this.lifecycle.track(this.addPaneNow(spec, opts));
  }

  private async addPaneNow(
    spec?: Partial<TerminalSpec>,
    opts?: PaneAddOptions,
  ): Promise<TerminalPane | null> {
    const pane = new TerminalPane();
    const anchorId = this.focusedId;
    pane.el.style.visibility = "hidden";

    const cwd = spec?.cwd ?? this.defaultCwd;
    const cliId = spec?.cliId ?? this.activeCliId;
    const profile = resolveProfile(cliId);
    const command = profile.command || undefined;
    const baseArgs = spec?.launchArgs ?? profile.args;
    let spawnError: string | null = null;
    if (opts?.adoptPtyId) this.adopting.set(opts.adoptPtyId, pane);
    try {
      await pane.attach(this.grid, {
        cwd,
        command,
        args: opts?.extraArgs ? [...(baseArgs ?? []), ...opts.extraArgs] : baseArgs,
        cliId: profile.id,
        existingPtyId: opts?.adoptPtyId,
        snapshot: opts?.snapshot,
      });
    } catch (error) {
      spawnError = errorMessage(error);
    }
    if (opts?.adoptPtyId) this.adopting.delete(opts.adoptPtyId);
    if (this.lifecycle.disposed) {
      await pane.dispose();
      return null;
    }

    pane.el.style.visibility = "";
    // Spawn failures keep the pane visible so the user can read the error and
    // close it manually. ptyId is empty in that case — we mint a synthetic id
    // so the pane still has a stable handle in the maps and the close button
    // can find it.
    const ptyId = pane.ptyId || `failed-${crypto.randomUUID()}`;
    const finalSpec = createdPaneSpec(ptyId, profile.id, spec);
    this.panes.set(ptyId, pane);
    this.order.push(ptyId);
    this.layout = appendTerminalPane(this.layout, ptyId, anchorId, opts?.splitPosition);
    this.syncOrderToLayout();
    if (!spawnError && !pane.isExited) this.liveIds.add(ptyId);
    this.specsById.set(ptyId, finalSpec);
    pane.el.dataset.ptyId = ptyId;

    this.wirePaneCallbacks(pane, ptyId);

    if (spawnError) {
      pane.markSpawnFailed(command ?? "shell", spawnError);
    } else {
      this.registerBell(pane, ptyId);
    }

    if (!opts?.silent) {
      this.setFocus(ptyId);
      this.relayout();
      this.emitAll();
    }

    if (!spawnError && !opts?.skipStartupCmd) {
      this.scheduleStartupCmd(ptyId, finalSpec.startupCmd);
    }
    return pane;
  }

  private wirePaneCallbacks(pane: TerminalPane, ptyId: string): void {
    const dockingHandle = wireTerminalPane(pane, ptyId, {
      grid: this.grid,
      isLive: (id) => this.isLive(id),
      getSpec: (id) => this.specsById.get(id),
      updateSpec: (id, patch) => this.updateSpec(id, patch),
      requestRespawn: (id, cliId) => this.requestRespawn(id, cliId),
      suspendPane: (id) => this.suspendPane(id),
      resumePane: (id) => this.resumePane(id),
      dockAtRoot: (id, position) => this.dockAtRoot(id, position),
      dock: (sourceId, targetId, position) => this.dock(sourceId, targetId, position),
      setFocus: (id) => this.setFocus(id),
      close: (id) => this.close(id),
      tearOff: this.onTearOff,
      orderLength: () => this.order.length,
    });
    this.dockingHandles.set(ptyId, dockingHandle);
  }

  private registerBell(pane: TerminalPane, ptyId: string): void {
    const ctx = this.notificationContext;
    if (!ctx) return;
    const projectId = this.projectId;
    const handle = registerManagerBell({
      pane,
      paneId: ptyId,
      projectId,
      ctx,
      getTerminalTitle: () =>
        this.specsById.get(ptyId)?.title ?? pane.titleEl.textContent ?? "terminal",
      onEmit: (pending) => this.emit({ type: "bell-pending", projectId, paneId: ptyId, pending }),
    });
    this.bellHandles.set(ptyId, handle);
  }

  private scheduleStartupCmd(ptyId: string, startupCmd: string | undefined): void {
    scheduleTerminalWrite(this.panes, ptyId, startupCmd, "startupCmd");
  }

  private async requestRespawn(ptyId: string, cliId: string): Promise<void> {
    const pane = this.panes.get(ptyId);
    if (!pane) return;
    if (pane.hasOutput && !(await confirmRespawn(cliId))) return;
    await this.respawnPane(ptyId, cliId);
  }

  async respawnPane(ptyId: string, cliId: string): Promise<void> {
    const current = this.specsById.get(ptyId);
    if (!current) return;
    await this.replacePane(ptyId, {
      title: current.title,
      cwd: current.cwd,
      startupCmd: current.startupCmd,
      cliId,
    });
  }

  suspendPane(ptyId: string): void {
    if (this.lifecycle.disposed || this.lifecycle.frozen) return;
    const pane = this.panes.get(ptyId);
    if (!pane || !this.isLive(ptyId)) return;
    this.updateSpec(ptyId, { suspended: true });
    pane.markSuspended();
    void ptyKill(ptyId);
  }

  suspendAll(): void {
    for (const id of [...this.liveIds]) this.suspendPane(id);
  }

  async resumePane(paneId: string): Promise<void> {
    const current = this.specsById.get(paneId);
    if (!current?.suspended || this.isLive(paneId)) return;
    const resumeArgs = current.launchArgs ? undefined : resolveProfile(current.cliId).resumeArgs;
    const shouldReplay =
      !resumeArgs &&
      !!current.lastShellCommand &&
      shouldReplayShellCommand(current.lastShellCommand, current.lastShellCommandAlias === true);
    const newId = await this.replacePane(
      paneId,
      { ...current, suspended: undefined },
      {
        extraArgs: resumeArgs,
        skipStartupCmd:
          current.launchArgs !== undefined || resumeArgs !== undefined || shouldReplay,
      },
    );
    if (newId && shouldReplay && current.lastShellCommand) {
      this.scheduleShellReplay(newId, current.lastShellCommand);
    }
  }

  // Sequential, not concurrent: overlapping replacePane calls stomp on each
  // other's layout snapshot and corrupt the grid.
  async resumeAll(): Promise<void> {
    for (const id of [...this.order]) {
      if (!this.specsById.get(id)?.suspended) continue;
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        await this.resumePane(id);
      } catch (error) {
        console.error(`Failed to resume pane ${id}`, error);
      }
    }
  }

  private scheduleShellReplay(ptyId: string, command: string): void {
    scheduleTerminalWrite(this.panes, ptyId, command, "lastShellCommand");
  }

  private async replacePane(
    paneId: string,
    spec: Partial<TerminalSpec>,
    opts?: { extraArgs?: string[]; skipStartupCmd?: boolean },
  ): Promise<string | null> {
    if (this.lifecycle.disposed || this.lifecycle.frozen) return null;
    return this.lifecycle.track(this.replacePaneNow(paneId, spec, opts));
  }

  private async replacePaneNow(
    paneId: string,
    spec: Partial<TerminalSpec>,
    opts?: { extraArgs?: string[]; skipStartupCmd?: boolean },
  ): Promise<string | null> {
    if (this.respawning.has(paneId)) return null;
    this.respawning.add(paneId);
    try {
      const newId = await replacePaneSlot(
        paneId,
        { order: this.order, layout: this.layout },
        () => this.close(paneId, { silent: true }),
        () => this.addPane(spec, { silent: true, ...opts }),
        (layout, id) => {
          this.layout = layout;
          this.syncOrderToLayout();
          this.setFocus(id);
        },
      );
      this.relayout();
      this.emitAll();
      return newId;
    } finally {
      this.respawning.delete(paneId);
    }
  }

  /** `keepPty` removes the pane but leaves its process running for another window. */
  async close(ptyId: string, opts?: { silent?: boolean; keepPty?: boolean }): Promise<void> {
    if (this.lifecycle.disposed || (this.lifecycle.frozen && !opts?.keepPty)) return;
    return this.lifecycle.track(this.closeNow(ptyId, opts));
  }

  private async closeNow(
    ptyId: string,
    opts?: { silent?: boolean; keepPty?: boolean },
  ): Promise<void> {
    const pane = this.panes.get(ptyId);
    if (!pane) return;
    this.panes.delete(ptyId);
    this.specsById.delete(ptyId);
    const wasLive = this.liveIds.delete(ptyId);
    this.bellHandles.get(ptyId)?.dispose();
    this.bellHandles.delete(ptyId);
    this.dockingHandles.get(ptyId)?.dispose();
    this.dockingHandles.delete(ptyId);
    this.layout = removeTerminalPane(this.layout, ptyId);
    const idx = this.order.indexOf(ptyId);
    if (idx >= 0) this.order.splice(idx, 1);
    if (this.focusedId === ptyId) {
      if (opts?.silent) {
        this.focusedId = null;
      } else {
        this.focusedId = this.order[Math.max(0, idx - 1)] ?? null;
        if (this.focusedId) this.setFocus(this.focusedId, true);
      }
    }
    await pane.dispose(opts);
    if (!opts?.silent) {
      this.relayout();
      if (wasLive) this.emitCount();
      this.emitSpecs();
      this.emitLayout();
    }
  }

  markExited(ptyId: string): void {
    if (!this.liveIds.delete(ptyId)) return;
    this.emitCount();
  }

  private addSuspendedPane(spec: TerminalSpec): void {
    if (this.lifecycle.disposed || this.lifecycle.frozen) return;
    const pane = new TerminalPane();
    const profile = resolveProfile(spec.cliId);
    pane.attachPlaceholder(this.grid, {
      cliId: profile.id,
      command: profile.command || undefined,
    });
    const paneId = spec.id;
    this.panes.set(paneId, pane);
    this.order.push(paneId);
    this.layout = appendTerminalPane(this.layout, paneId);
    this.specsById.set(paneId, { ...spec, cliId: profile.id });
    pane.el.dataset.ptyId = paneId;
    this.wirePaneCallbacks(pane, paneId);
  }

  closeFocused(): void {
    if (this.focusedId) void this.close(this.focusedId);
  }

  setFocus(ptyId: string, focusTerm = false): void {
    this.focusedId = ptyId;
    for (const [id, pane] of this.panes) {
      pane.el.classList.toggle("focused", id === ptyId);
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

  focusDirection(direction: FocusDirection): void {
    const boxes = paneBoxes(this.order, (id) => this.panes.get(id)?.el);
    const next = resolveDirectionalFocus(boxes, this.focusedId, direction);
    if (next && next !== this.focusedId) this.setFocus(next, true);
  }

  /** Tears down every PTY + xterm and removes gridEl from any parent. */
  async dispose(opts?: { keepPty?: boolean }): Promise<void> {
    this.lifecycle.disposed = true;
    this.lifecycle.thaw();
    this.listeners.clear();
    await this.lifecycle.drain();
    for (const handle of this.bellHandles.values()) handle.dispose();
    this.bellHandles.clear();
    for (const handle of this.dockingHandles.values()) handle.dispose();
    this.dockingHandles.clear();
    const toClose = [...this.panes.values()];
    this.panes.clear();
    this.liveIds.clear();
    this.specsById.clear();
    this.order.splice(0);
    this.layout = null;
    this.focusedId = null;
    await Promise.all(toClose.map((p) => p.dispose(opts).catch(() => undefined)));
    this.grid.remove();
  }

  /** Replays persisted specs as panes, emitting one batched spec-changed at
   * the end so persistence writes are not amplified per pane. `adopt` renders
   * PTYs that are already running under the spec ids instead of spawning. */
  async restoreSpecs(
    specs: TerminalSpec[],
    opts?: { adopt?: boolean; snapshots?: PaneSnapshots },
  ): Promise<void> {
    if (this.lifecycle.disposed || this.lifecycle.frozen) return;
    return this.lifecycle.track(this.restoreSpecsNow(specs, opts));
  }

  private async restoreSpecsNow(
    specs: TerminalSpec[],
    opts?: { adopt?: boolean; snapshots?: PaneSnapshots },
  ): Promise<void> {
    if (specs.length === 0) return;
    this.suppressPersistenceEvents = true;
    let idMap: Map<string, string>;
    try {
      idMap = await restorePaneSpecs(
        specs,
        opts,
        (spec) => this.addSuspendedPane(spec),
        (spec, options) => this.addPane(spec, options),
      );
    } finally {
      this.suppressPersistenceEvents = false;
    }
    this.layout = this.initialLayout
      ? repairTerminalLayout(this.initialLayout, this.order, idMap)
      : createDefaultTerminalLayout(this.order);
    this.initialLayout = null;
    this.syncOrderToLayout();
    this.relayout();
    this.emitSpecs();
    this.emitLayout();
  }

  async applyTemplate(template: LayoutTemplate): Promise<void> {
    if (this.lifecycle.disposed || this.lifecycle.frozen) return;
    return this.lifecycle.track(this.applyTemplateNow(template));
  }

  private async applyTemplateNow(template: LayoutTemplate): Promise<void> {
    const live = this.order.map((id) => ({ id, cliId: this.specsById.get(id)?.cliId }));
    const idMap = await executeTemplatePlan(
      planTemplateApplication(template.specs, live),
      async (spec) => {
        const pane = await this.addPane(spec, { silent: true });
        return pane?.el.dataset.ptyId ?? null;
      },
    );
    this.layout = repairTerminalLayout(template.layout, this.order, idMap);
    this.syncOrderToLayout();
    if (!this.focusedId && this.order.length > 0) this.setFocus(this.order[0]);
    this.relayout();
    this.emitAll();
  }

  private relayout(): void {
    layoutTerminalSplits(this.grid, this.layout, this.panes, {
      refit: () => this.refit(),
      onRatioChange: (path, ratio) => this.updateSplitRatio(path, ratio),
    });
  }

  dock(sourceId: string, targetId: string, position: TerminalDockPosition): void {
    this.applyLayout(dockTerminalPane(this.layout, sourceId, targetId, position));
  }

  dockAtRoot(sourceId: string, position: TerminalDockPosition): void {
    this.applyLayout(dockTerminalPaneAtRoot(this.layout, sourceId, position));
  }

  private updateSplitRatio(path: TerminalLayoutPath, ratio: number): void {
    this.applyLayout(updateTerminalSplitRatio(this.layout, path, ratio));
  }

  private applyLayout(next: TerminalLayoutNode | null, rerender = true): void {
    if (this.lifecycle.disposed || this.lifecycle.frozen || next === this.layout) return;
    this.layout = next;
    this.syncOrderToLayout();
    if (rerender) this.relayout();
    this.emitLayout();
  }

  private syncOrderToLayout(): void {
    const nextOrder = terminalLayoutPaneIds(this.layout).filter((id) => this.panes.has(id));
    this.order.splice(0, this.order.length, ...nextOrder);
  }

  private emitAll(): void {
    this.emitCount();
    this.emitSpecs();
    this.emitLayout();
  }

  private emitCount(): void {
    this.emit({
      type: "count-changed",
      projectId: this.projectId,
      count: this.order.length,
    });
  }

  private emitSpecs(): void {
    if (this.suppressPersistenceEvents) return;
    this.emit({
      type: "spec-changed",
      projectId: this.projectId,
      specs: this.specs(),
    });
  }

  private emitLayout(): void {
    if (this.suppressPersistenceEvents) return;
    this.emit({ type: "layout-changed", projectId: this.projectId, layout: this.layout });
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

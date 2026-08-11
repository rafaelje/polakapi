import type { LayoutTemplate, ProjectId } from "../workspaces/state/types";
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
  replaceTerminalPaneId,
  terminalLayoutPaneIds,
  updateTerminalSplitRatio,
  type TerminalDockPosition,
  type TerminalLayoutNode,
  type TerminalLayoutPath,
} from "./terminal-layout";
import { TerminalPane } from "./terminal-pane";
import { scheduleTerminalWrite, wireTerminalPane } from "./terminal-pane-wiring";
import { shouldReplayShellCommand } from "./resume-whitelist";
import { equalStringArrays } from "./terminal-spec-utils";
import { ptyKill } from "./pty-client";
import {
  registerManagerBell,
  type BellNotificationHandle,
  type NotificationContext,
} from "./terminal-notifications";
import { layoutTerminalSplits } from "./terminal-split-layout";
import { type TerminalSpec } from "./types";

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export type { NotificationContext };

export interface TerminalManagerOptions {
  /** Identity used for router lookup + events. */
  projectId: ProjectId;
  /** project.path applied when a spec omits cwd. */
  defaultCwd: string;
  layout?: TerminalLayoutNode;
  /** Default CLI id for new panes; undefined falls back to "shell". */
  activeCliId?: string;
  /** Optional. When omitted, panes do not register bell notifications. */
  notificationContext?: NotificationContext;
}

export type TerminalManagerEvent =
  | { type: "count-changed"; projectId: ProjectId; count: number }
  | { type: "spec-changed"; projectId: ProjectId; specs: TerminalSpec[] }
  | { type: "layout-changed"; projectId: ProjectId; layout: TerminalLayoutNode | null }
  | { type: "bell-pending"; projectId: ProjectId; paneId: string; pending: boolean };

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
  /** Per-pane bell handles, disposed on close() / dispose(). */
  private readonly bellHandles = new Map<string, BellNotificationHandle>();
  private readonly dockingHandles = new Map<string, TerminalDockingHandle>();
  /**
   * Guards `respawnPane` against re-entry — a double click on the badge menu
   * (or two close-together IPC events) would otherwise spawn two replacement
   * panes for one slot, with the second seeing the first's already-deleted
   * spec and silently no-oping.
   */
  private readonly respawning = new Set<string>();
  private activeCliId: string;
  readonly projectId: ProjectId;

  constructor(opts: TerminalManagerOptions) {
    this.projectId = opts.projectId;
    this.defaultCwd = opts.defaultCwd;
    this.initialLayout = opts.layout ?? null;
    this.activeCliId = opts.activeCliId && opts.activeCliId.length > 0 ? opts.activeCliId : "shell";
    this.notificationContext = opts.notificationContext ?? null;
    const grid = document.createElement("div");
    grid.className = "terminal-grid";
    this.grid = grid;
  }

  /**
   * F5: late binding. The bootstrap may not have constructed the notification
   * context yet when getOrCreate fires (e.g. during restore); calling this
   * after construction wires bells for any future panes. Already-spawned
   * panes are NOT retro-wired — they pre-date the context and we'd risk
   * double-registering on a reconnect.
   */
  setNotificationContext(ctx: NotificationContext | null): void {
    this.notificationContext = ctx;
  }

  /** Patch the in-memory spec and emit spec-changed so it is persisted. */
  updateSpec(terminalId: string, patch: Partial<Omit<TerminalSpec, "id">>): void {
    const current = this.specsById.get(terminalId);
    if (!current) return;
    const next: TerminalSpec = { ...current, ...patch, id: current.id };
    // Identity preservation: bail out when nothing actually changed so we
    // don't trigger a redundant persist round-trip.
    if (
      next.title === current.title &&
      next.cwd === current.cwd &&
      next.startupCmd === current.startupCmd &&
      next.cliId === current.cliId &&
      equalStringArrays(next.launchArgs, current.launchArgs) &&
      next.suspended === current.suspended &&
      next.lastShellCommand === current.lastShellCommand &&
      next.lastShellCommandAlias === current.lastShellCommandAlias
    ) {
      return;
    }
    this.specsById.set(terminalId, next);
    this.emitSpecs();
  }

  get gridEl(): HTMLElement {
    return this.grid;
  }

  get size(): number {
    return this.liveIds.size;
  }

  /** Count of specs currently suspended (placeholder panes) — drives the
   * "Resume terminals (N)" row-menu item, mirroring `getLiveCount`. */
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
    return this.panes.get(id);
  }

  /** True for spawned, non-exited PTY sessions — false for failed spawns
   * (synthetic `failed-*` ids) and exited processes. Writers must check it. */
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

  /**
   * Spawn a pane backed by the given spec. When `spec.cwd` is undefined the
   * manager substitutes `defaultCwd` (the owning project's path).
   */
  async addPane(
    spec?: Partial<TerminalSpec>,
    opts?: { silent?: boolean; extraArgs?: string[]; skipStartupCmd?: boolean },
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
    try {
      await pane.attach(this.grid, {
        cwd,
        command,
        args: opts?.extraArgs ? [...(baseArgs ?? []), ...opts.extraArgs] : baseArgs,
        cliId: profile.id,
      });
    } catch (error) {
      spawnError = errorMessage(error);
    }

    pane.el.style.visibility = "";
    // Spawn failures keep the pane visible so the user can read the error and
    // close it manually. ptyId is empty in that case — we mint a synthetic id
    // so the pane still has a stable handle in the maps and the close button
    // can find it.
    const ptyId = pane.ptyId || `failed-${crypto.randomUUID()}`;
    const finalSpec: TerminalSpec = {
      id: ptyId,
      title: spec?.title,
      cwd: spec?.cwd,
      startupCmd: spec?.startupCmd,
      cliId: profile.id,
      launchArgs: spec?.launchArgs,
      lastShellCommand: spec?.lastShellCommand,
      lastShellCommandAlias: spec?.lastShellCommandAlias,
    };
    this.panes.set(ptyId, pane);
    this.order.push(ptyId);
    this.layout = appendTerminalPane(this.layout, ptyId, anchorId);
    if (!spawnError) this.liveIds.add(ptyId);
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

  // Delegates to terminal-pane-wiring.ts, kept out of this file for the line budget.
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
      orderLength: () => this.order.length,
    });
    this.dockingHandles.set(ptyId, dockingHandle);
  }

  /**
   * F5: wire bell notifications. The manager is the single owner of the
   * handle and disposes it in close()/dispose().
   */
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

  /** Confirm-and-respawn; the modal is skipped for panes with no output yet. */
  private async requestRespawn(ptyId: string, cliId: string): Promise<void> {
    const pane = this.panes.get(ptyId);
    if (!pane) return;
    if (pane.hasOutput && !(await confirmRespawn(cliId))) return;
    await this.respawnPane(ptyId, cliId);
  }

  /** Kill-and-respawn with `cliId`, clearing launch arguments but preserving the grid slot. */
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
    if (this.respawning.has(paneId)) return null;
    this.respawning.add(paneId);
    try {
      const targetIdx = this.order.indexOf(paneId);
      const preservedLayout = this.layout;
      await this.close(paneId, { silent: true });
      const pane = await this.addPane(spec, { silent: true, ...opts });
      if (!pane) {
        this.relayout();
        this.emitAll();
        return null;
      }
      const newId = pane.ptyId || this.order[this.order.length - 1];
      if (newId && targetIdx >= 0) {
        const fromIdx = this.order.indexOf(newId);
        if (fromIdx >= 0 && fromIdx !== targetIdx) {
          this.order.splice(fromIdx, 1);
          this.order.splice(targetIdx, 0, newId);
        }
        this.layout = replaceTerminalPaneId(preservedLayout, paneId, newId);
        this.syncOrderToLayout();
        this.setFocus(newId);
      }
      this.relayout();
      this.emitAll();
      return newId || null;
    } finally {
      this.respawning.delete(paneId);
    }
  }

  async close(ptyId: string, opts?: { silent?: boolean }): Promise<void> {
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
    await pane.dispose();
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
  async dispose(): Promise<void> {
    this.listeners.clear();
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
    await Promise.all(toClose.map((p) => p.dispose().catch(() => undefined)));
    this.grid.remove();
  }

  /** Replays persisted specs as panes, emitting one batched spec-changed at
   * the end so persistence writes are not amplified per pane. */
  async restoreSpecs(specs: TerminalSpec[]): Promise<void> {
    if (specs.length === 0) return;
    const idMap = new Map<string, string>();
    this.suppressPersistenceEvents = true;
    try {
      for (const spec of specs) {
        if (spec.suspended) {
          this.addSuspendedPane(spec);
          idMap.set(spec.id, spec.id);
          continue;
        }
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const pane = await this.addPane(spec);
        const restoredId = pane?.el.dataset.ptyId;
        if (restoredId) idMap.set(spec.id, restoredId);
      }
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
    const live = this.order.map((id) => ({ id, cliId: this.specsById.get(id)?.cliId }));
    const idMap = await executeTemplatePlan(
      planTemplateApplication(template.specs, live),
      async (spec) => {
        const pane = await this.addPane(
          { title: spec.title, startupCmd: spec.startupCmd, cliId: spec.cliId },
          { silent: true },
        );
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
    if (next === this.layout) return;
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

import type { ProjectId } from "../workspaces/types";
import { confirmModal } from "../workspaces/confirm-delete";
import { resolveProfile } from "./cli-registry";
import { layoutTerminalGrid } from "./terminal-grid-layout";
import { TerminalPane } from "./terminal-pane";
import { ptyWrite } from "./pty-client";
import { registerBellNotification, type BellNotificationHandle } from "./terminal-notifications";
import { type TerminalSpec } from "./types";

/**
 * Empirical delay before piping `startupCmd` into a freshly-spawned PTY.
 * Long enough for zsh/bash on macOS + Linux to print their first prompt;
 * short enough to feel instantaneous. Fire-and-forget — we do not parse PS1.
 */
const STARTUP_CMD_DELAY_MS = 200;

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * F5: external state the bell wiring needs to make a focus decision. Provided
 * by the bootstrap so the manager itself does not depend on the router or the
 * window-focus tracker. `getProjectName` is also late-bound so renames after
 * pane spawn still flow into the OS notification title.
 */
export interface NotificationContext {
  /** Currently active project id (router-level state). */
  getActiveProjectId(): ProjectId | null;
  /** Whether the OS window currently holds focus. */
  isWindowFocused(): boolean;
  /** Resolves the current project name (rename-safe). */
  getProjectName(projectId: ProjectId): string;
  /** Forwards bell pendings out of the manager (badge driver). */
  onBellPending(projectId: ProjectId, paneId: string, pending: boolean): void;
}

export interface TerminalManagerOptions {
  /** Identity used for router lookup + events. */
  projectId: ProjectId;
  /** project.path applied when a spec omits cwd. */
  defaultCwd: string;
  /** Initial number of columns per row. Must be >= 1. */
  gridCols: number;
  /**
   * Default CLI id for new panes. Undefined falls back to "shell". Persisted
   * by the bootstrap so chip selection survives restart.
   */
  activeCliId?: string;
  /** Optional. When omitted, panes do not register bell notifications. */
  notificationContext?: NotificationContext;
}

export type TerminalManagerEvent =
  | { type: "count-changed"; projectId: ProjectId; count: number }
  | { type: "spec-changed"; projectId: ProjectId; specs: TerminalSpec[] }
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
  private readonly specsById = new Map<string, TerminalSpec>();
  private focusedId: string | null = null;
  private readonly grid: HTMLElement;
  private cols: number;
  private defaultCwd: string;
  private readonly listeners = new Set<TerminalManagerListener>();
  private suppressSpecEvent = false;
  private notificationContext: NotificationContext | null;
  /** Per-pane bell handles, disposed on close() / dispose(). */
  private readonly bellHandles = new Map<string, BellNotificationHandle>();
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
    this.cols = Math.max(1, Math.floor(opts.gridCols));
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
      next.cliId === current.cliId
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
    return this.order.length;
  }

  get focusedPaneId(): string | null {
    return this.focusedId;
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
    opts?: { silent?: boolean },
  ): Promise<TerminalPane | null> {
    const pane = new TerminalPane();
    pane.el.style.visibility = "hidden";

    const cwd = spec?.cwd ?? this.defaultCwd;
    const cliId = spec?.cliId ?? this.activeCliId;
    const profile = resolveProfile(cliId);
    const command = profile.command || undefined;
    let spawnError: string | null = null;
    try {
      await pane.attach(this.grid, {
        cwd,
        command,
        args: profile.args,
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
    };
    this.panes.set(ptyId, pane);
    this.order.push(ptyId);
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
      this.emitCount();
      this.emitSpecs();
    }

    if (!spawnError) {
      this.scheduleStartupCmd(ptyId, finalSpec.startupCmd);
    }
    return pane;
  }

  private wirePaneCallbacks(pane: TerminalPane, ptyId: string): void {
    // Inject callbacks that let the pane menu read + persist its own startup
    // command without holding a reference to the workspaces controller. The
    // manager remains the single owner of the spec table.
    pane.setStartupCmdCallbacks({
      getStartupCmd: () => this.specsById.get(ptyId)?.startupCmd,
      onChange: (next) => this.updateSpec(ptyId, { startupCmd: next }),
    });
    pane.setCliRespawnCallbacks({
      getCurrentCliId: () => this.specsById.get(ptyId)?.cliId ?? "shell",
      onRespawnRequest: (cliId) => {
        void this.requestRespawn(ptyId, cliId);
      },
    });
    pane.el.addEventListener("mousedown", () => this.setFocus(ptyId));
    pane.bodyEl.addEventListener("focusin", () => this.setFocus(ptyId));
    pane.closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.close(ptyId);
    });
  }

  /**
   * F5: wire bell notifications. The manager is the single owner of the
   * handle and disposes it in close()/dispose(). The "active + focused"
   * predicate is resolved at fire-time via the injected notificationContext,
   * not captured here, so a project becoming active later (without spawning
   * new panes) still suppresses its existing bells correctly.
   */
  private registerBell(pane: TerminalPane, ptyId: string): void {
    const ctx = this.notificationContext;
    if (!ctx) return;
    const projectId = this.projectId;
    const bellHandle = registerBellNotification({
      pane,
      paneId: ptyId,
      projectId,
      getProjectName: () => ctx.getProjectName(projectId),
      getTerminalTitle: () =>
        this.specsById.get(ptyId)?.title ?? pane.titleEl.textContent ?? "terminal",
      isActiveAndFocused: () => ctx.getActiveProjectId() === projectId && ctx.isWindowFocused(),
      onPendingBell: (pending) => {
        ctx.onBellPending(projectId, ptyId, pending);
        this.emit({
          type: "bell-pending",
          projectId,
          paneId: ptyId,
          pending,
        });
      },
    });
    this.bellHandles.set(ptyId, bellHandle);
  }

  private scheduleStartupCmd(ptyId: string, startupCmd: string | undefined): void {
    // F4: auto-execute the startup command into the freshly spawned PTY.
    // Fire-and-forget — the 200ms delay gives the shell time to print its
    // first prompt; we do not block addPane and do not parse PS1.
    if (!startupCmd || startupCmd.trim().length === 0) return;
    setTimeout(() => {
      // Pane may have been closed between spawn and timer fire.
      if (!this.panes.has(ptyId)) return;
      void ptyWrite(ptyId, `${startupCmd}\r`).catch((error) => {
        console.error("Failed to write startupCmd", error);
      });
    }, STARTUP_CMD_DELAY_MS);
  }

  /**
   * Confirm-and-respawn. Skips the modal for empty panes (no output received
   * yet) so the very common "spawned the wrong CLI, swap right away" case is
   * frictionless. Otherwise prompts the user since respawn kills the live
   * process.
   */
  private async requestRespawn(ptyId: string, cliId: string): Promise<void> {
    const pane = this.panes.get(ptyId);
    if (!pane) return;
    if (pane.hasOutput) {
      const profile = resolveProfile(cliId);
      const ok = await confirmModal({
        title: `Respawn terminal with ${profile.label}?`,
        message: "The current process will be killed and a new one started. Output will be lost.",
        confirmLabel: "Respawn",
        danger: true,
      });
      if (!ok) return;
    }
    await this.respawnPane(ptyId, cliId);
  }

  /**
   * Kill the current PTY for a pane and spawn a new one using `cliId`.
   * Preserves cwd / title / startupCmd and the pane's grid slot. The pane's
   * ptyId changes — external holders of the old id must invalidate.
   */
  async respawnPane(ptyId: string, cliId: string): Promise<void> {
    if (this.respawning.has(ptyId)) return;
    const current = this.specsById.get(ptyId);
    if (!current) return;
    this.respawning.add(ptyId);
    try {
      const targetIdx = this.order.indexOf(ptyId);
      const preserved: Partial<TerminalSpec> = {
        title: current.title,
        cwd: current.cwd,
        startupCmd: current.startupCmd,
        cliId,
      };
      await this.close(ptyId, { silent: true });
      const pane = await this.addPane(preserved, { silent: true });
      if (!pane) {
        this.relayout();
        this.emitCount();
        this.emitSpecs();
        return;
      }
      const newId = pane.ptyId || this.order[this.order.length - 1];
      if (newId && targetIdx >= 0) {
        const fromIdx = this.order.indexOf(newId);
        if (fromIdx >= 0 && fromIdx !== targetIdx) {
          this.order.splice(fromIdx, 1);
          this.order.splice(targetIdx, 0, newId);
        }
        this.setFocus(newId);
      }
      this.relayout();
      this.emitSpecs();
    } finally {
      this.respawning.delete(ptyId);
    }
  }

  /** Backward-compat alias used by code paths that have not migrated yet. */
  create(): Promise<TerminalPane | null> {
    return this.addPane();
  }

  async close(ptyId: string, opts?: { silent?: boolean }): Promise<void> {
    const pane = this.panes.get(ptyId);
    if (!pane) return;
    this.panes.delete(ptyId);
    this.specsById.delete(ptyId);
    this.bellHandles.get(ptyId)?.dispose();
    this.bellHandles.delete(ptyId);
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
      this.emitCount();
      this.emitSpecs();
    }
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
    for (const handle of this.bellHandles.values()) handle.dispose();
    this.bellHandles.clear();
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

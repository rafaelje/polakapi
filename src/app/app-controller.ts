import { type UnlistenFn } from "@tauri-apps/api/event";
import {
  loadLayout,
  flushSave,
  queueSave,
  type PersistedLayout,
} from "../shared/persistence/store";
import { wireShortcuts } from "../shared/keyboard/shortcuts";
import { invoke } from "../shared/tauri/invoke";
import { showToast } from "../shared/ui/toast";
import { onPtyData, onPtyExit, ptyKill } from "../modules/terminal/pty-client";
import {
  formatMemoryIndicator,
  startMemoryGuard,
  type MemoryGuardHandle,
} from "../modules/terminal/memory-guard";
import { openMemorySettingsMenu } from "../modules/terminal/memory-settings-menu";
import { startFlexDrag, wireSidebarGutters } from "../modules/layout/gutters";
import { wireToggles } from "../modules/layout/panel-toggles";
import { type SidebarTarget } from "../modules/layout/types";
import { applyNotesHeight } from "../modules/notes/notes-panel";
import { persistNotesHeight as queueNotesHeightSave } from "../modules/notes/notes-persistence";
import {
  mountCommandPalette,
  type CommandPaletteHandle,
} from "../modules/workspaces/command-palette/command-palette";
import { mountBottomPanel, type BottomPanelHandle } from "../modules/bottom-panel/bottom-panel";
import { isBottomTab } from "../modules/bottom-panel/types";
import { mountLoopButton, type LoopButtonHandle } from "../modules/agents-flow/loop-window";
import {
  mountPromptsButton,
  type PromptsButtonHandle,
} from "../modules/agents-flow/prompts-window";
import {
  mountAdversarialButton,
  type AdversarialButtonHandle,
} from "../modules/agents-flow/adversarial-window";
import {
  mountAgentsButton,
  type AgentsButtonHandle,
} from "../modules/agents-library/agents-button";
import {
  createAgentsController,
  type AgentsController,
} from "../modules/agents-library/agents-controller";
import { flushSaveAgents } from "../shared/persistence/agents-store";
import { bootstrapWorkspaces, type WorkspacesBootstrapHandle } from "./workspaces-bootstrap";
import { wireWindowLifecycle } from "./lifecycle";
import { wireQuitConfirm } from "./quit-confirm";
import { TerminalRouter } from "./terminal-router";
import { type AppElements } from "./elements";

export class AppController {
  private readonly router: TerminalRouter;
  private workspaces: WorkspacesBootstrapHandle | null = null;
  private palette: CommandPaletteHandle | null = null;
  private bottomPanel: BottomPanelHandle | null = null;
  private loopButton: LoopButtonHandle | null = null;
  private promptsButton: PromptsButtonHandle | null = null;
  private adversarialButton: AdversarialButtonHandle | null = null;
  private agentsButton: AgentsButtonHandle | null = null;
  private agentsController: AgentsController | null = null;
  private unwireShortcuts: (() => void) | null = null;
  private unwireWindowLifecycle: (() => void) | null = null;
  private memoryGuard: MemoryGuardHandle | null = null;
  private memoryLimitMb = 0;
  private idleSuspendMinutes = 0;
  private unwireQuitConfirm: (() => void) | null = null;
  private unwireFocus: (() => void) | null = null;
  private unlistenData: UnlistenFn | null = null;
  private unlistenExit: UnlistenFn | null = null;
  /**
   * F5: cached window focus state. document.hasFocus() can lie momentarily
   * during alt-tab on macOS, so we track the focus/blur transitions ourselves
   * and treat the initial "before first focus event" as not-focused so the
   * first bell after launch still fires when warranted.
   */
  private windowFocused = false;
  private disposed = false;

  constructor(private readonly elements: AppElements) {
    this.router = new TerminalRouter({
      onPersistSpecs: (projectId, specs) => {
        this.workspaces?.controller.replaceTerminalSpecs(projectId, specs);
      },
      onPersistLayout: (projectId, layout) => {
        this.workspaces?.controller.setProjectTerminalLayout(projectId, layout);
      },
    });
  }

  async start(): Promise<void> {
    const layout = await this.loadSavedLayout();
    this.applyLayout(layout);
    this.bottomPanel = mountBottomPanel({
      initialTab: isBottomTab(layout.activeBottomTab) ? layout.activeBottomTab : "notes",
      onTabChange: (tab) => queueSave({ activeBottomTab: tab }),
    });
    this.loopButton = mountLoopButton();
    this.promptsButton = mountPromptsButton();
    this.adversarialButton = mountAdversarialButton();
    // Eager boot — same pattern as workspaces/loop profiles — so the first
    // /agents open never flashes an empty list while agents.json loads.
    this.agentsController = await createAgentsController();
    this.agentsButton = mountAgentsButton({
      router: this.router,
      controller: this.agentsController,
      onAfterInsert: (target) => {
        this.router.findPaneById(target.ptyId)?.manager.setFocus(target.ptyId, true);
      },
    });
    await this.wirePtyEvents();
    this.wireGutters();
    this.wirePanelToggles();
    this.wireKeepAwakeToggle(layout.keepAwakeEnabled === true);
    this.wireKeyboardShortcuts();
    this.wireWindowFocus();
    this.unwireWindowLifecycle = wireWindowLifecycle({
      onBeforeUnload: () => this.dispose(),
      onResize: () => {
        this.router.getActive()?.refit();
        this.bottomPanel?.refit();
      },
    });

    this.workspaces = await bootstrapWorkspaces({
      elements: this.elements,
      router: this.router,
      isWindowFocused: () => this.windowFocused,
    });

    // Mount the command palette once the controller is ready. The shortcut
    // handler resolves through `this.palette?` so the Cmd-P keybinding wired
    // earlier in start() is a no-op until this line runs.
    this.palette = mountCommandPalette({ controller: this.workspaces.controller });

    this.wireMemoryGuard(layout);

    // Wire the quit hook *after* workspaces is ready so the modal can resolve
    // project names by looking the controller's state up at confirm time.
    const workspaces = this.workspaces;
    this.unwireQuitConfirm = wireQuitConfirm({
      router: this.router,
      getState: () => workspaces.controller.getState(),
      beforeQuit: () => this.flushBeforeQuit(),
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.unlistenData?.();
    this.unlistenData = null;
    this.unlistenExit?.();
    this.unlistenExit = null;
    this.unwireShortcuts?.();
    this.unwireShortcuts = null;
    this.unwireWindowLifecycle?.();
    this.unwireWindowLifecycle = null;
    this.unwireQuitConfirm?.();
    this.unwireQuitConfirm = null;
    this.unwireFocus?.();
    this.unwireFocus = null;
    this.memoryGuard?.dispose();
    this.memoryGuard = null;

    this.palette?.dispose();
    this.palette = null;

    const bottomPanel = this.bottomPanel;
    this.bottomPanel = null;
    if (bottomPanel) {
      void bottomPanel.dispose().catch((error) => {
        console.error("Failed to dispose bottom panel", error);
      });
    }

    this.loopButton?.dispose();
    this.loopButton = null;

    this.promptsButton?.dispose();
    this.promptsButton = null;

    this.adversarialButton?.dispose();
    this.adversarialButton = null;

    this.agentsButton?.dispose();
    this.agentsButton = null;

    const agentsController = this.agentsController;
    this.agentsController = null;
    if (agentsController) {
      void agentsController.dispose().catch((error) => {
        console.error("Failed to dispose agents controller", error);
      });
    }

    const workspaces = this.workspaces;
    this.workspaces = null;
    if (workspaces) {
      // Dispose order contract (F3):
      //   1. notesPanel — flushes pending text SYNCHRONOUSLY into the
      //      controller so it lands in state before flushSaveWorkspaces runs.
      //   2. unsubscribe — drop event listeners.
      //   3. panel/projectPane/breadcrumb — UI teardown.
      //   4. controller.dispose() — awaits flushSaveWorkspaces().
      workspaces.notesPanel.dispose();
      workspaces.unsubscribe();
      workspaces.panel.unmount();
      workspaces.projectPane.dispose();
      workspaces.breadcrumb.dispose();
      void workspaces.controller.dispose().catch((error) => {
        console.error("Failed to dispose workspaces controller", error);
      });
    }

    for (const id of this.router.allPaneIds()) {
      void ptyKill(id);
    }
    void this.router.disposeAll().catch((error) => {
      console.error("Failed to dispose terminal router", error);
    });
    void flushSave().catch((error) => console.error("Failed to flush layout before unload", error));
  }

  private async flushBeforeQuit(): Promise<void> {
    const workspaces = this.workspaces;
    if (workspaces) {
      workspaces.notesPanel.dispose();
      await workspaces.controller.dispose();
    }
    await flushSaveAgents();
    await flushSave();
  }

  private async wirePtyEvents(): Promise<void> {
    this.unlistenData = await onPtyData(({ id, data }) => {
      if (this.bottomPanel?.handlePtyData(id, data)) return;
      this.router.findPaneById(id)?.pane.write(data);
    });
    this.unlistenExit = await onPtyExit(({ id }) => {
      if (this.bottomPanel?.handlePtyExit(id)) return;
      const found = this.router.findPaneById(id);
      if (!found) return;
      found.pane.markExited();
      found.manager.markExited(id);
    });
  }

  private wireGutters(): void {
    const sidebars: Record<SidebarTarget, HTMLElement> = {
      "sidebar-left": this.elements.sidebarLeft,
      "sidebar-right": this.elements.sidebarRight,
    };
    wireSidebarGutters(sidebars, () => {
      this.router.getActive()?.refit();
      this.persistSidebarWidths();
    });
    const notesGutter = this.elements.notesGutter;
    if (notesGutter) {
      notesGutter.addEventListener("mousedown", (e) =>
        startFlexDrag(e, notesGutter, "v", () => {
          this.router.getActive()?.refit();
          this.bottomPanel?.refit();
          this.persistCurrentNotesHeight();
        }),
      );
    }
  }

  private wirePanelToggles(): void {
    wireToggles(
      [
        { btnId: "toggle-left", target: this.elements.mainRow, cls: "hide-left" },
        { btnId: "toggle-right", target: this.elements.layoutEl, cls: "hide-right" },
        { btnId: "toggle-bottom", target: this.elements.rightCol, cls: "hide-notes" },
      ],
      () => {
        this.router.getActive()?.refit();
        this.bottomPanel?.refit();
        queueSave({
          hideLeft: this.elements.mainRow.classList.contains("hide-left"),
          hideRight: this.elements.layoutEl.classList.contains("hide-right"),
          hideNotes: this.elements.rightCol.classList.contains("hide-notes"),
        });
      },
    );
  }

  private wireWindowFocus(): void {
    // Seed from the synchronous probe — false on cold start (no focus event
    // fired yet) is intentional: first bell after launch should still fire if
    // the user is alt-tabbed away.
    this.windowFocused = document.hasFocus();
    const onFocus = (): void => {
      this.windowFocused = true;
    };
    const onBlur = (): void => {
      this.windowFocused = false;
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    this.unwireFocus = (): void => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }

  private wireKeyboardShortcuts(): void {
    this.unwireShortcuts = wireShortcuts({
      newPane: () => void this.router.getActive()?.addPane(),
      closeFocused: () => this.router.getActive()?.closeFocused(),
      focusByIndex: (idx) => this.router.getActive()?.focusByIndex(idx),
      focusPrev: () => this.router.getActive()?.focusRelative(-1),
      focusNext: () => this.router.getActive()?.focusRelative(1),
      focusDirection: (direction) => this.router.getActive()?.focusDirection(direction),
      // Resolved lazily so the keybinding is harmless before bootstrap mounts.
      togglePalette: () => this.palette?.toggle(),
    });
  }

  private wireMemoryGuard(layout: PersistedLayout): void {
    this.memoryLimitMb = layout.memoryLimitMb ?? 0;
    this.idleSuspendMinutes = layout.idleSuspendMinutes ?? 0;
    const btn = document.getElementById("memory-indicator");
    this.memoryGuard = startMemoryGuard({
      getPanes: () => this.router.livePanes(),
      getActiveProjectId: () => this.workspaces?.controller.getActiveProject()?.id ?? null,
      getLimitMb: () => this.memoryLimitMb,
      getIdleLimitMs: () => this.idleSuspendMinutes * 60_000,
      suspendPane: (paneId) => this.router.findPaneById(paneId)?.manager.suspendPane(paneId),
      onStats: (stats, usedMb) => {
        if (!btn) return;
        btn.textContent = formatMemoryIndicator(usedMb, this.memoryLimitMb);
        btn.title =
          `Terminals: ${usedMb} MB · limit ${this.memoryLimitMb > 0 ? `${this.memoryLimitMb} MB` : "off"} · ` +
          `idle: ${this.idleSuspendMinutes > 0 ? `${this.idleSuspendMinutes} min` : "off"} · ` +
          `system free: ${stats.availableMb} MB — click to configure`;
      },
    });
    btn?.addEventListener("click", () => {
      openMemorySettingsMenu({
        trigger: btn,
        limitMb: this.memoryLimitMb,
        idleMinutes: this.idleSuspendMinutes,
        onLimitChange: (mb) => {
          this.memoryLimitMb = mb;
          queueSave({ memoryLimitMb: mb });
          void this.memoryGuard?.tick();
        },
        onIdleChange: (minutes) => {
          this.idleSuspendMinutes = minutes;
          queueSave({ idleSuspendMinutes: minutes });
          void this.memoryGuard?.tick();
        },
      });
    });
  }

  private wireKeepAwakeToggle(initial: boolean): void {
    const btn = document.getElementById("toggle-awake");
    if (!btn) return;
    const apply = async (enabled: boolean, showFeedback: boolean): Promise<void> => {
      try {
        const active = await invoke<boolean>("keep_awake_set", { enabled });
        btn.classList.toggle("active", active);
        queueSave({ keepAwakeEnabled: active });
        if (showFeedback) {
          showToast(active ? "System sleep inhibited" : "System sleep restored", "info");
        }
      } catch {
        // invoke() already surfaced the error toast
      }
    };
    btn.addEventListener("click", () => {
      void apply(!btn.classList.contains("active"), true);
    });
    if (initial) void apply(true, false);
  }

  private persistSidebarWidths(): void {
    queueSave({
      sidebarLeftWidth: this.elements.sidebarLeft.getBoundingClientRect().width,
      sidebarRightWidth: this.elements.sidebarRight.getBoundingClientRect().width,
    });
  }

  private persistCurrentNotesHeight(): void {
    queueNotesHeightSave(this.elements.notes.panel);
  }

  private applyLayout(layout: PersistedLayout): void {
    if (typeof layout.sidebarLeftWidth === "number") {
      this.elements.sidebarLeft.style.width = `${layout.sidebarLeftWidth}px`;
    }
    if (typeof layout.sidebarRightWidth === "number") {
      this.elements.sidebarRight.style.width = `${layout.sidebarRightWidth}px`;
    }
    applyNotesHeight(layout, this.elements.notes);
    if (layout.hideLeft)
      this.toggleClassAndButton(this.elements.mainRow, "hide-left", "toggle-left");
    if (layout.hideRight) {
      this.toggleClassAndButton(this.elements.layoutEl, "hide-right", "toggle-right");
    }
    if (layout.hideNotes) {
      this.toggleClassAndButton(this.elements.rightCol, "hide-notes", "toggle-bottom");
    }
  }

  private toggleClassAndButton(target: HTMLElement, cls: string, btnId: string): void {
    target.classList.add(cls);
    document.getElementById(btnId)?.classList.remove("active");
  }

  private async loadSavedLayout(): Promise<PersistedLayout> {
    try {
      return await loadLayout();
    } catch (error) {
      console.error("Failed to load saved layout", error);
      showToast("Could not load saved layout", "error");
      return {};
    }
  }
}

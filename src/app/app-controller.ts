import { type UnlistenFn } from "@tauri-apps/api/event";
import {
  loadLayout,
  flushSave,
  queueSave,
  type PersistedLayout,
} from "../shared/persistence/store";
import { wireShortcuts } from "../shared/keyboard/shortcuts";
import { showToast } from "../shared/ui/toast";
import { onPtyData, onPtyExit, ptyKill } from "../modules/terminal/pty-client";
import { startFlexDrag, wireSidebarGutters } from "../modules/layout/gutters";
import { wireToggles } from "../modules/layout/panel-toggles";
import { type SidebarTarget } from "../modules/layout/types";
import { applyNotesHeight } from "../modules/notes/notes-panel";
import { persistNotesHeight as queueNotesHeightSave } from "../modules/notes/notes-persistence";
import {
  mountCommandPalette,
  type CommandPaletteHandle,
} from "../modules/workspaces/command-palette";
import { bootstrapWorkspaces, type WorkspacesBootstrapHandle } from "./workspaces-bootstrap";
import { wireWindowLifecycle } from "./lifecycle";
import { wireQuitConfirm } from "./quit-confirm";
import { TerminalRouter } from "./terminal-router";
import { type AppElements } from "./elements";

const DEFAULT_GRID_COLS = 2;
const MIN_GRID_COLS = 1;
const MAX_GRID_COLS = 8;

export class AppController {
  private readonly router: TerminalRouter;
  private workspaces: WorkspacesBootstrapHandle | null = null;
  private palette: CommandPaletteHandle | null = null;
  private unwireShortcuts: (() => void) | null = null;
  private unwireWindowLifecycle: (() => void) | null = null;
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
      defaultGridCols: DEFAULT_GRID_COLS,
      onPersistSpecs: (projectId, specs) => {
        this.workspaces?.controller.replaceTerminalSpecs(projectId, specs);
      },
      onPersistCols: (projectId, cols) => {
        this.workspaces?.controller.setProjectCols(projectId, cols);
      },
    });
  }

  async start(): Promise<void> {
    const layout = await this.loadSavedLayout();
    this.applyLayout(layout);
    await this.wirePtyEvents();
    this.wireGutters();
    this.wirePanelToggles();
    this.wireKeyboardShortcuts();
    this.wireWindowFocus();
    this.unwireWindowLifecycle = wireWindowLifecycle({
      onBeforeUnload: () => this.dispose(),
      onResize: () => this.router.getActive()?.refit(),
    });

    this.workspaces = await bootstrapWorkspaces({
      elements: this.elements,
      router: this.router,
      clampGridCols: (value) => this.clampGridCols(value),
      isWindowFocused: () => this.windowFocused,
    });

    // Mount the command palette once the controller is ready. The shortcut
    // handler resolves through `this.palette?` so the Cmd-P keybinding wired
    // earlier in start() is a no-op until this line runs.
    this.palette = mountCommandPalette({ controller: this.workspaces.controller });

    // Wire the quit hook *after* workspaces is ready so the modal can resolve
    // project names by looking the controller's state up at confirm time.
    const workspaces = this.workspaces;
    this.unwireQuitConfirm = wireQuitConfirm({
      router: this.router,
      getState: () => workspaces.controller.getState(),
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

    this.palette?.dispose();
    this.palette = null;

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

  private async wirePtyEvents(): Promise<void> {
    this.unlistenData = await onPtyData(({ id, data }) => {
      this.router.findPaneById(id)?.pane.write(data);
    });
    this.unlistenExit = await onPtyExit(({ id }) => {
      this.router.findPaneById(id)?.pane.markExited();
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
      // Resolved lazily so the keybinding is harmless before bootstrap mounts.
      togglePalette: () => this.palette?.toggle(),
    });
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

  private clampGridCols(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_GRID_COLS;
    return Math.min(MAX_GRID_COLS, Math.max(MIN_GRID_COLS, Math.floor(value)));
  }
}

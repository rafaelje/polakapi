import { type UnlistenFn } from "@tauri-apps/api/event";
import {
  loadLayout,
  flushSave,
  queueSave,
  type PersistedLayout,
} from "../shared/persistence/store";
import { wireShortcuts } from "../shared/keyboard/shortcuts";
import { showToast } from "../shared/ui/toast";
import { TerminalManager } from "../modules/terminal/terminal-manager";
import { onPtyData, onPtyExit, ptyKill } from "../modules/terminal/pty-client";
import { startFlexDrag, wireSidebarGutters } from "../modules/layout/gutters";
import { wireToggles } from "../modules/layout/panel-toggles";
import { type SidebarTarget } from "../modules/layout/types";
import { applyNotesLayout } from "../modules/notes/notes-panel";
import {
  persistNotesHeight as queueNotesHeightSave,
  wireNotesPersistence,
} from "../modules/notes/notes-persistence";
import { bootstrapWorkspaces, type WorkspacesBootstrapHandle } from "./workspaces-bootstrap";
import { wireWindowLifecycle } from "./lifecycle";
import { type AppElements } from "./elements";

const DEFAULT_GRID_COLS = 2;
const MIN_GRID_COLS = 1;
const MAX_GRID_COLS = 8;
const INITIAL_PANES = 4;

export class AppController {
  private readonly paneManager: TerminalManager;
  private workspaces: WorkspacesBootstrapHandle | null = null;
  private unwireShortcuts: (() => void) | null = null;
  private unwireWindowLifecycle: (() => void) | null = null;
  private unlistenData: UnlistenFn | null = null;
  private unlistenExit: UnlistenFn | null = null;
  private disposed = false;

  constructor(private readonly elements: AppElements) {
    this.paneManager = new TerminalManager({
      gridEl: elements.gridEl,
      gridCols: DEFAULT_GRID_COLS,
    });
  }

  async start(): Promise<void> {
    const layout = await this.loadSavedLayout();
    this.applyLayout(layout);
    await this.wirePtyEvents();
    this.wireGutters();
    this.wirePanelToggles();
    wireNotesPersistence(this.elements.notes.textarea);
    this.wireKeyboardShortcuts();
    this.unwireWindowLifecycle = wireWindowLifecycle({
      onBeforeUnload: () => this.dispose(),
      onResize: () => this.paneManager.refit(),
    });

    this.workspaces = await bootstrapWorkspaces({
      elements: this.elements,
      paneManager: this.paneManager,
      clampGridCols: (value) => this.clampGridCols(value),
    });

    // F1 decision: only seed default terminals when a project is active. With
    // no active project the grid is hidden behind the project empty state and
    // creating panes would render off-screen.
    if (this.workspaces.controller.getActiveProject()) {
      for (let i = 0; i < INITIAL_PANES; i++) {
        await this.paneManager.create();
      }
    }
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

    const workspaces = this.workspaces;
    this.workspaces = null;
    if (workspaces) {
      workspaces.unsubscribe();
      workspaces.panel.unmount();
      workspaces.projectPane.dispose();
      workspaces.breadcrumb.dispose();
      void workspaces.controller.dispose().catch((error) => {
        console.error("Failed to dispose workspaces controller", error);
      });
    }

    for (const id of this.paneManager.ids()) {
      void ptyKill(id);
    }
    void flushSave().catch((error) => console.error("Failed to flush layout before unload", error));
  }

  private async wirePtyEvents(): Promise<void> {
    this.unlistenData = await onPtyData(({ id, data }) => {
      this.paneManager.get(id)?.write(data);
    });
    this.unlistenExit = await onPtyExit(({ id }) => {
      this.paneManager.get(id)?.markExited();
    });
  }

  private wireGutters(): void {
    const sidebars: Record<SidebarTarget, HTMLElement> = {
      "sidebar-left": this.elements.sidebarLeft,
      "sidebar-right": this.elements.sidebarRight,
    };
    wireSidebarGutters(sidebars, () => {
      this.paneManager.refit();
      this.persistSidebarWidths();
    });
    const notesGutter = this.elements.notesGutter;
    if (notesGutter) {
      notesGutter.addEventListener("mousedown", (e) =>
        startFlexDrag(e, notesGutter, "v", () => {
          this.paneManager.refit();
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
        this.paneManager.refit();
        queueSave({
          hideLeft: this.elements.mainRow.classList.contains("hide-left"),
          hideRight: this.elements.layoutEl.classList.contains("hide-right"),
          hideNotes: this.elements.rightCol.classList.contains("hide-notes"),
        });
      },
    );
  }

  private wireKeyboardShortcuts(): void {
    this.unwireShortcuts = wireShortcuts({
      newPane: () => void this.paneManager.create(),
      closeFocused: () => this.paneManager.closeFocused(),
      focusByIndex: (idx) => this.paneManager.focusByIndex(idx),
      focusPrev: () => this.paneManager.focusRelative(-1),
      focusNext: () => this.paneManager.focusRelative(1),
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
    if (typeof layout.gridCols === "number") {
      const clamped = this.clampGridCols(layout.gridCols);
      this.paneManager.setGridCols(clamped);
      this.workspaces?.projectPane.setGridCols(clamped);
    }
    applyNotesLayout(layout, this.elements.notes);
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

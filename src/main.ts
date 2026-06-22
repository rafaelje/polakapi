import { type UnlistenFn } from "@tauri-apps/api/event";
import {
  applyNotesLayout,
  getNotesElements,
  persistNotesHeight as queueNotesHeightSave,
  wireNotes,
} from "./features/notes/notes";
import { PaneManager } from "./features/terminal/pane-manager";
import { onPtyData, onPtyExit, ptyKill, ptyWrite } from "./features/terminal/pty";
import {
  startFlexDrag,
  wireSidebarGutters,
  wireToggles,
  type SidebarTarget,
} from "./features/layout/layout";
import { flushSave, loadLayout, queueSave, type PersistedLayout } from "./shared/persistence";
import { wireShortcuts } from "./shared/shortcuts";
import { showToast } from "./shared/toast";
import { requireById } from "./shared/dom";
import { promptModal } from "./shared/modal";

const DEFAULT_GRID_COLS = 2;
const MIN_GRID_COLS = 1;
const MAX_GRID_COLS = 8;
const INITIAL_PANES = 4;

const gridEl = requireById<HTMLDivElement>("grid", HTMLDivElement);
const sidebarLeft = requireById("sidebar-left");
const sidebarRight = requireById("sidebar-right");
const layoutEl = requireById("layout");
const mainRow = requireById("main-row");
const rightCol = requireById("right-col");
const notesGutter = document.getElementById("gutter-notes");
const notesElements = getNotesElements();

const paneManager = new PaneManager({ gridEl, gridCols: DEFAULT_GRID_COLS });
let unwireShortcuts: (() => void) | null = null;
let unlistenData: UnlistenFn | null = null;
let unlistenExit: UnlistenFn | null = null;

async function wirePtyEvents(): Promise<void> {
  unlistenData = await onPtyData(({ id, data }) => {
    paneManager.get(id)?.write(data);
  });
  unlistenExit = await onPtyExit(({ id }) => {
    paneManager.get(id)?.markExited();
  });
}

function clampGridCols(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_GRID_COLS;
  return Math.min(MAX_GRID_COLS, Math.max(MIN_GRID_COLS, Math.floor(value)));
}

function wireToolbar(): void {
  document.getElementById("add-pane")?.addEventListener("click", () => void paneManager.create());

  document.getElementById("run-all")?.addEventListener("click", () => {
    void (async () => {
      const cmd = await promptModal({
        title: "Run command in all terminals",
        message: "The command will be sent followed by Enter to every open terminal.",
        placeholder: "e.g. ls",
        confirmLabel: "Run",
      });
      if (!cmd) return;
      const payload = `${cmd}\r`;
      for (const id of paneManager.ids()) void ptyWrite(id, payload);
    })();
  });

  const colsInput = document.getElementById("grid-cols");
  if (colsInput instanceof HTMLInputElement) {
    colsInput.value = String(paneManager.gridCols);
    colsInput.addEventListener("change", () => {
      const next = clampGridCols(Number(colsInput.value));
      colsInput.value = String(next);
      paneManager.setGridCols(next);
      queueSave({ gridCols: next });
    });
  }
}

function persistSidebarWidths(): void {
  queueSave({
    sidebarLeftWidth: sidebarLeft.getBoundingClientRect().width,
    sidebarRightWidth: sidebarRight.getBoundingClientRect().width,
  });
}

function persistCurrentNotesHeight(): void {
  queueNotesHeightSave(notesElements.panel);
}

function wireGutters(): void {
  const sidebars: Record<SidebarTarget, HTMLElement> = {
    "sidebar-left": sidebarLeft,
    "sidebar-right": sidebarRight,
  };
  wireSidebarGutters(sidebars, () => {
    paneManager.refit();
    persistSidebarWidths();
  });
  if (notesGutter) {
    notesGutter.addEventListener("mousedown", (e) =>
      startFlexDrag(e, notesGutter, "v", () => {
        paneManager.refit();
        persistCurrentNotesHeight();
      }),
    );
  }
}

function wirePanelToggles(): void {
  wireToggles(
    [
      { btnId: "toggle-left", target: mainRow, cls: "hide-left" },
      { btnId: "toggle-right", target: layoutEl, cls: "hide-right" },
      { btnId: "toggle-bottom", target: rightCol, cls: "hide-notes" },
    ],
    () => {
      paneManager.refit();
      queueSave({
        hideLeft: mainRow.classList.contains("hide-left"),
        hideRight: layoutEl.classList.contains("hide-right"),
        hideNotes: rightCol.classList.contains("hide-notes"),
      });
    },
  );
}

function applyLayout(layout: PersistedLayout): void {
  if (typeof layout.sidebarLeftWidth === "number") {
    sidebarLeft.style.width = `${layout.sidebarLeftWidth}px`;
  }
  if (typeof layout.sidebarRightWidth === "number") {
    sidebarRight.style.width = `${layout.sidebarRightWidth}px`;
  }
  if (typeof layout.gridCols === "number") {
    paneManager.setGridCols(clampGridCols(layout.gridCols));
  }
  applyNotesLayout(layout, notesElements);
  if (layout.hideLeft) toggleClassAndButton(mainRow, "hide-left", "toggle-left");
  if (layout.hideRight) toggleClassAndButton(layoutEl, "hide-right", "toggle-right");
  if (layout.hideNotes) toggleClassAndButton(rightCol, "hide-notes", "toggle-bottom");
}

function toggleClassAndButton(target: HTMLElement, cls: string, btnId: string): void {
  target.classList.add(cls);
  document.getElementById(btnId)?.classList.remove("active");
}

window.addEventListener("beforeunload", () => {
  unlistenData?.();
  unlistenData = null;
  unlistenExit?.();
  unlistenExit = null;
  unwireShortcuts?.();
  unwireShortcuts = null;
  for (const id of paneManager.ids()) {
    void ptyKill(id);
  }
  void flushSave().catch((error) => console.error("Failed to flush layout before unload", error));
});
window.addEventListener("resize", () => paneManager.refit());

async function loadSavedLayout(): Promise<PersistedLayout> {
  try {
    return await loadLayout();
  } catch (error) {
    console.error("Failed to load saved layout", error);
    showToast("Could not load saved layout", "error");
    return {};
  }
}

async function init(): Promise<void> {
  const layout = await loadSavedLayout();
  applyLayout(layout);
  await wirePtyEvents();
  wireGutters();
  wirePanelToggles();
  wireToolbar();
  wireNotes(notesElements.textarea);
  unwireShortcuts = wireShortcuts({
    newPane: () => void paneManager.create(),
    closeFocused: () => paneManager.closeFocused(),
    focusByIndex: (idx) => paneManager.focusByIndex(idx),
    focusPrev: () => paneManager.focusRelative(-1),
    focusNext: () => paneManager.focusRelative(1),
  });
  for (let i = 0; i < INITIAL_PANES; i++) await paneManager.create();
}

void init().catch((error) => {
  console.error("Application failed to initialize", error);
  showToast("Application failed to initialize", "error");
});

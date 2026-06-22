import { type UnlistenFn } from "@tauri-apps/api/event";
import { TerminalPane } from "./terminal-pane";
import { onPtyData, onPtyExit, ptyKill, ptyWrite } from "./pty";
import {
  makeFlexGutter,
  startFlexDrag,
  wireSidebarGutters,
  wireToggles,
  type SidebarTarget,
} from "./layout";
import { flushSave, loadLayout, queueSave } from "./persistence";

const GRID_COLS = 2;
const INITIAL_PANES = 4;

const panes = new Map<string, TerminalPane>();
const paneOrder: string[] = [];

const gridEl = document.getElementById("grid") as HTMLDivElement;
const sidebarLeft = document.getElementById("sidebar-left") as HTMLElement;
const sidebarRight = document.getElementById("sidebar-right") as HTMLElement;
const layoutEl = document.getElementById("layout") as HTMLElement;
const mainRow = document.getElementById("main-row") as HTMLElement;
const rightCol = document.getElementById("right-col") as HTMLElement;
const notesEl = document.getElementById("notes");
const notesGutter = document.getElementById("gutter-notes");
const notesTextarea = document.querySelector<HTMLTextAreaElement>(".notes-body");

function refit(): void {
  for (const pane of panes.values()) pane.fit();
}

function setFocused(ptyId: string): void {
  for (const pane of panes.values()) {
    pane.el.classList.toggle("focused", pane.ptyId === ptyId);
  }
}

function relayout(): void {
  for (const id of paneOrder) {
    const p = panes.get(id);
    p?.el.parentElement?.removeChild(p.el);
  }
  gridEl.innerHTML = "";
  for (let i = 0; i < paneOrder.length; i += GRID_COLS) {
    if (i > 0) gridEl.append(makeFlexGutter("v", refit));
    const row = document.createElement("div");
    row.className = "grid-row";
    paneOrder.slice(i, i + GRID_COLS).forEach((id, idx) => {
      const p = panes.get(id);
      if (!p) return;
      p.el.style.flex = "1 1 0";
      if (idx > 0) row.append(makeFlexGutter("h", refit));
      row.append(p.el);
    });
    gridEl.append(row);
  }
  requestAnimationFrame(refit);
}

async function createPane(opts?: { command?: string; args?: string[] }): Promise<TerminalPane> {
  const pane = new TerminalPane();
  pane.el.style.visibility = "hidden";
  await pane.attach(gridEl, opts);
  pane.el.style.visibility = "";

  panes.set(pane.ptyId, pane);
  paneOrder.push(pane.ptyId);

  pane.el.addEventListener("mousedown", () => setFocused(pane.ptyId));
  pane.bodyEl.addEventListener("focusin", () => setFocused(pane.ptyId));
  pane.closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void closePane(pane.ptyId);
  });

  setFocused(pane.ptyId);
  relayout();
  return pane;
}

async function closePane(ptyId: string): Promise<void> {
  const pane = panes.get(ptyId);
  if (!pane) return;
  panes.delete(ptyId);
  const idx = paneOrder.indexOf(ptyId);
  if (idx >= 0) paneOrder.splice(idx, 1);
  await pane.dispose();
  relayout();
}

let unlistenData: UnlistenFn | null = null;
let unlistenExit: UnlistenFn | null = null;

async function wirePtyEvents(): Promise<void> {
  unlistenData = await onPtyData(({ id, data }) => {
    panes.get(id)?.write(data);
  });
  unlistenExit = await onPtyExit(({ id }) => {
    panes.get(id)?.markExited();
  });
}

function wireToolbar(): void {
  document.getElementById("add-pane")?.addEventListener("click", () => void createPane());
  document.getElementById("run-all")?.addEventListener("click", () => {
    const cmd = prompt("Command to send to every terminal (will be followed by Enter):");
    if (!cmd) return;
    const payload = cmd + "\r";
    for (const id of panes.keys()) void ptyWrite(id, payload);
  });
}

function persistSidebarWidths(): void {
  queueSave({
    sidebarLeftWidth: sidebarLeft.getBoundingClientRect().width,
    sidebarRightWidth: sidebarRight.getBoundingClientRect().width,
  });
}

function persistNotesHeight(): void {
  if (!notesEl) return;
  queueSave({ notesHeight: notesEl.getBoundingClientRect().height });
}

function wireGutters(): void {
  const sidebars: Record<SidebarTarget, HTMLElement> = {
    "sidebar-left": sidebarLeft,
    "sidebar-right": sidebarRight,
  };
  wireSidebarGutters(sidebars, () => {
    refit();
    persistSidebarWidths();
  });
  if (notesGutter) {
    notesGutter.addEventListener("mousedown", (e) =>
      startFlexDrag(e, notesGutter, "v", () => {
        refit();
        persistNotesHeight();
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
      refit();
      queueSave({
        hideLeft: mainRow.classList.contains("hide-left"),
        hideRight: layoutEl.classList.contains("hide-right"),
        hideNotes: rightCol.classList.contains("hide-notes"),
      });
    },
  );
}

function wireNotes(): void {
  if (!notesTextarea) return;
  notesTextarea.addEventListener("input", () => {
    queueSave({ notesContent: notesTextarea.value });
  });
}

function applyLayout(layout: Awaited<ReturnType<typeof loadLayout>>): void {
  if (typeof layout.sidebarLeftWidth === "number") {
    sidebarLeft.style.width = `${layout.sidebarLeftWidth}px`;
  }
  if (typeof layout.sidebarRightWidth === "number") {
    sidebarRight.style.width = `${layout.sidebarRightWidth}px`;
  }
  if (typeof layout.notesHeight === "number" && notesEl) {
    notesEl.style.flex = `0 0 ${layout.notesHeight}px`;
  }
  if (layout.hideLeft) toggleClassAndButton(mainRow, "hide-left", "toggle-left");
  if (layout.hideRight) toggleClassAndButton(layoutEl, "hide-right", "toggle-right");
  if (layout.hideNotes) toggleClassAndButton(rightCol, "hide-notes", "toggle-bottom");
  if (typeof layout.notesContent === "string" && notesTextarea) {
    notesTextarea.value = layout.notesContent;
  }
}

function toggleClassAndButton(target: HTMLElement, cls: string, btnId: string): void {
  target.classList.add(cls);
  document.getElementById(btnId)?.classList.remove("active");
}

window.addEventListener("beforeunload", () => {
  unlistenData?.();
  unlistenExit?.();
  for (const id of panes.keys()) void ptyKill(id);
  void flushSave();
});
window.addEventListener("resize", () => refit());

async function init(): Promise<void> {
  const layout = await loadLayout();
  applyLayout(layout);
  await wirePtyEvents();
  wireGutters();
  wirePanelToggles();
  wireToolbar();
  wireNotes();
  for (let i = 0; i < INITIAL_PANES; i++) await createPane();
}

void init();

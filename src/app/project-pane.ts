import type { Project } from "../modules/workspaces/types";
import {
  createProjectEmptyState,
  type EmptyStateHandle,
} from "../modules/workspaces/workspaces-empty-state";

export interface ProjectPaneCallbacks {
  onAddTerminal(): void;
  onRunInAll(): void;
  onSetGridCols(value: number): void;
}

export interface ProjectPaneOptions {
  host: HTMLElement;
  gridEl: HTMLDivElement;
  gridCols: number;
  callbacks: ProjectPaneCallbacks;
}

export interface ProjectPaneHandle {
  setActiveProject(project: Project | null): void;
  setGridCols(value: number): void;
  dispose(): void;
}

const MIN_COLS = 1;
const MAX_COLS = 8;

/**
 * Wraps the existing `#grid` with a local sub-toolbar containing the actions
 * that used to live in the global toolbar (+ Terminal, Run in all, Cols).
 * The sub-toolbar and the grid are only visible when a project is active.
 */
export function mountProjectPane(opts: ProjectPaneOptions): ProjectPaneHandle {
  const { host, gridEl, callbacks } = opts;

  // Preserve where the grid lived so we can restore on dispose.
  const originalParent = gridEl.parentElement;
  const originalNext = gridEl.nextSibling;

  host.classList.add("project-pane");

  const subToolbar = document.createElement("div");
  subToolbar.className = "project-pane-toolbar";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.id = "add-pane";
  addBtn.textContent = "+ Terminal";

  const runAllBtn = document.createElement("button");
  runAllBtn.type = "button";
  runAllBtn.id = "run-all";
  runAllBtn.textContent = "Run command in all…";

  const colsLabel = document.createElement("label");
  colsLabel.className = "toolbar-field";
  colsLabel.htmlFor = "grid-cols";
  const colsSpan = document.createElement("span");
  colsSpan.textContent = "Cols";
  const colsInput = document.createElement("input");
  colsInput.id = "grid-cols";
  colsInput.type = "number";
  colsInput.min = String(MIN_COLS);
  colsInput.max = String(MAX_COLS);
  colsInput.step = "1";
  colsInput.value = String(clamp(opts.gridCols));
  colsLabel.append(colsSpan, colsInput);

  subToolbar.append(addBtn, runAllBtn, colsLabel);

  let emptyState: EmptyStateHandle | null = createProjectEmptyState();

  // Insert sub-toolbar and the grid into `host`, then append the empty state
  // below them (it is only visible when no project is active — `gridEl` is
  // hidden via the `inactive` modifier).
  host.replaceChildren(subToolbar, gridEl, emptyState.element);
  host.classList.add("inactive");
  // Start disabled — setActiveProject(project) flips them on once the
  // bootstrap layer wires the router to an active project.
  addBtn.disabled = true;
  runAllBtn.disabled = true;
  colsInput.disabled = true;

  const onAdd = (): void => callbacks.onAddTerminal();
  const onRunAll = (): void => callbacks.onRunInAll();
  const onColsChange = (): void => {
    const next = clamp(Number(colsInput.value));
    colsInput.value = String(next);
    callbacks.onSetGridCols(next);
  };

  addBtn.addEventListener("click", onAdd);
  runAllBtn.addEventListener("click", onRunAll);
  colsInput.addEventListener("change", onColsChange);

  return {
    setActiveProject(project: Project | null): void {
      const active = project !== null;
      host.classList.toggle("inactive", !active);
      // Toolbar actions are meaningless without an active project (no router
      // target). Disable the controls so keyboard activation cannot reach a
      // null manager and quietly no-op.
      addBtn.disabled = !active;
      runAllBtn.disabled = !active;
      colsInput.disabled = !active;
      if (active && emptyState) {
        emptyState.dispose();
        emptyState = null;
      } else if (!active && !emptyState) {
        emptyState = createProjectEmptyState();
        host.append(emptyState.element);
      }
    },
    setGridCols(value: number): void {
      colsInput.value = String(clamp(value));
    },
    dispose(): void {
      addBtn.removeEventListener("click", onAdd);
      runAllBtn.removeEventListener("click", onRunAll);
      colsInput.removeEventListener("change", onColsChange);
      emptyState?.dispose();
      emptyState = null;
      subToolbar.remove();
      host.classList.remove("project-pane", "inactive");
      // Restore the grid to its original parent so callers that hold a
      // direct reference do not break.
      if (originalParent && originalParent !== host) {
        originalParent.insertBefore(gridEl, originalNext);
      }
    },
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return MIN_COLS;
  return Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(value)));
}

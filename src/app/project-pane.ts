import type { Project } from "../modules/workspaces/types";
import {
  createProjectEmptyState,
  type EmptyStateHandle,
} from "../modules/workspaces/workspaces-empty-state";
import { ALL_PROFILES, type CliProfile } from "../modules/terminal/cli-registry";

export interface ProjectPaneCallbacks {
  onAddTerminal(): void;
  onRunInAll(): void;
  onRevealFolder(path: string): void;
  onOpenInEditor(path: string): void;
  onSetActiveCli(cliId: string): void;
}

export interface ProjectPaneOptions {
  host: HTMLElement;
  gridEl: HTMLDivElement;
  callbacks: ProjectPaneCallbacks;
}

export interface ProjectPaneHandle {
  setActiveProject(project: Project | null): void;
  setActiveCli(cliId: string): void;
  dispose(): void;
}

interface ChipRow {
  element: HTMLDivElement;
  setActive(cliId: string): void;
  setDisabled(disabled: boolean): void;
  dispose(): void;
}

function createChipRow(onSelect: (cliId: string) => void): ChipRow {
  const element = document.createElement("div");
  element.className = "cli-chips";

  const chips: HTMLButtonElement[] = ALL_PROFILES.map((profile) => createChip(profile, onSelect));
  for (const chip of chips) element.append(chip);

  return {
    element,
    setActive(cliId: string): void {
      for (const chip of chips) {
        chip.classList.toggle("is-active", chip.dataset.cliId === cliId);
      }
    },
    setDisabled(disabled: boolean): void {
      for (const chip of chips) chip.disabled = disabled;
    },
    dispose(): void {
      for (const chip of chips) chip.replaceWith(chip.cloneNode(true));
      element.remove();
    },
  };
}

function createChip(profile: CliProfile, onSelect: (cliId: string) => void): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = `cli-chip cli-chip--${profile.id}`;
  chip.dataset.cliId = profile.id;
  chip.textContent = profile.label;
  chip.addEventListener("click", () => {
    if (chip.classList.contains("is-active")) return;
    onSelect(profile.id);
  });
  return chip;
}

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

  const revealBtn = document.createElement("button");
  revealBtn.type = "button";
  revealBtn.title = "Reveal in file manager";
  revealBtn.textContent = "Reveal";

  const editorBtn = document.createElement("button");
  editorBtn.type = "button";
  editorBtn.title = "Open in IDE";
  editorBtn.textContent = "Open in IDE";

  const externalGroup = document.createElement("div");
  externalGroup.className = "project-pane-external";
  externalGroup.append(revealBtn, editorBtn);

  const runAllBtn = document.createElement("button");
  runAllBtn.type = "button";
  runAllBtn.id = "run-all";
  runAllBtn.textContent = "Run command in all…";

  const chipRow = createChipRow((cliId) => {
    chipRow.setActive(cliId);
    callbacks.onSetActiveCli(cliId);
  });
  chipRow.setActive("shell");

  subToolbar.append(chipRow.element, addBtn, runAllBtn, externalGroup);

  let emptyState: EmptyStateHandle | null = createProjectEmptyState();
  let currentProject: Project | null = null;

  // Insert sub-toolbar and the grid into `host`, then append the empty state
  // below them (it is only visible when no project is active — `gridEl` is
  // hidden via the `inactive` modifier).
  host.replaceChildren(subToolbar, gridEl, emptyState.element);
  host.classList.add("inactive");
  // Start disabled — setActiveProject(project) flips them on once the
  // bootstrap layer wires the router to an active project.
  addBtn.disabled = true;
  runAllBtn.disabled = true;
  revealBtn.disabled = true;
  editorBtn.disabled = true;
  chipRow.setDisabled(true);

  const onAdd = (): void => callbacks.onAddTerminal();
  const onRunAll = (): void => callbacks.onRunInAll();
  const onReveal = (): void => {
    const path = currentProject?.path;
    if (path) callbacks.onRevealFolder(path);
  };
  const onEditor = (): void => {
    const path = currentProject?.path;
    if (path) callbacks.onOpenInEditor(path);
  };

  addBtn.addEventListener("click", onAdd);
  runAllBtn.addEventListener("click", onRunAll);
  revealBtn.addEventListener("click", onReveal);
  editorBtn.addEventListener("click", onEditor);

  return {
    setActiveProject(project: Project | null): void {
      currentProject = project;
      const active = project !== null;
      host.classList.toggle("inactive", !active);
      addBtn.disabled = !active;
      runAllBtn.disabled = !active;
      revealBtn.disabled = project === null || !project.path;
      editorBtn.disabled = project === null || !project.path;
      chipRow.setDisabled(!active);
      if (active && emptyState) {
        emptyState.dispose();
        emptyState = null;
      } else if (!active && !emptyState) {
        emptyState = createProjectEmptyState();
        host.append(emptyState.element);
      }
    },
    setActiveCli(cliId: string): void {
      chipRow.setActive(cliId);
    },
    dispose(): void {
      addBtn.removeEventListener("click", onAdd);
      runAllBtn.removeEventListener("click", onRunAll);
      revealBtn.removeEventListener("click", onReveal);
      editorBtn.removeEventListener("click", onEditor);
      chipRow.dispose();
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

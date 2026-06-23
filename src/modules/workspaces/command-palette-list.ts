import type { ColorToken, ProjectId } from "./types";

// ---------------------------------------------------------------------------
// F4 command palette — list rendering. Pure DOM, no state ownership.
//
// Kept separate from `command-palette.ts` so the orchestrator stays focused on
// lifecycle (open/close, listeners, indexing) while this file deals with the
// row markup + selection visuals. The orchestrator owns `selectedIdx` and the
// filtered slice; this module just paints them.
// ---------------------------------------------------------------------------

export interface PaletteItem {
  projectId: ProjectId;
  projectName: string;
  workspaceName: string;
  color: ColorToken;
  /** Lowercased haystack used by the orchestrator's filter step. */
  haystack: string;
}

export interface PaletteListCallbacks {
  /** Called when the mouse hovers an item — orchestrator updates selection. */
  onHover(idx: number): void;
  /** Called when an item is clicked — orchestrator activates it. */
  onActivate(idx: number): void;
}

/**
 * Render all rows fresh. Cheap because the list is bounded by the number of
 * projects (typically dozens, max a few hundred). Selection visuals are
 * driven by `updateSelection` below so the orchestrator can move the cursor
 * without a full re-render.
 */
export function renderPaletteList(
  listEl: HTMLElement,
  items: readonly PaletteItem[],
  selectedIdx: number,
  cb: PaletteListCallbacks,
): void {
  listEl.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cmd-palette-empty";
    empty.textContent = "No matching projects";
    listEl.append(empty);
    return;
  }
  items.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "cmd-palette-item";
    row.setAttribute("role", "option");
    if (idx === selectedIdx) row.setAttribute("aria-selected", "true");
    row.dataset.idx = String(idx);
    row.dataset.color = it.color;

    const chip = document.createElement("span");
    chip.className = "cmd-palette-chip";
    chip.dataset.color = it.color;

    const body = document.createElement("span");
    body.className = "cmd-palette-item-body";
    const subtitle = document.createElement("span");
    subtitle.className = "cmd-palette-item-subtitle";
    subtitle.textContent = it.workspaceName;
    const sep = document.createElement("span");
    sep.className = "cmd-palette-item-sep";
    sep.textContent = " / ";
    const title = document.createElement("span");
    title.className = "cmd-palette-item-title";
    title.textContent = it.projectName;
    body.append(subtitle, sep, title);

    row.append(chip, body);
    row.addEventListener("mouseenter", () => cb.onHover(idx));
    row.addEventListener("mousedown", (e) => {
      // mousedown so we beat the backdrop click-to-close.
      e.preventDefault();
      e.stopPropagation();
      cb.onActivate(idx);
    });
    listEl.append(row);
  });
}

/**
 * Update aria-selected and scroll the active row into view without rebuilding
 * the list. Called on ArrowUp/Down/hover.
 */
export function updatePaletteSelection(listEl: HTMLElement, selectedIdx: number): void {
  const rows = listEl.querySelectorAll<HTMLElement>(".cmd-palette-item");
  rows.forEach((row, idx) => {
    if (idx === selectedIdx) {
      row.setAttribute("aria-selected", "true");
      row.scrollIntoView({ block: "nearest" });
    } else {
      row.removeAttribute("aria-selected");
    }
  });
}

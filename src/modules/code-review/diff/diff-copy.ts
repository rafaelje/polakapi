import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { DiffRow, UnifiedRow } from "./diff-model";
import {
  formatReference,
  sideSelection,
  unifiedSelection,
  type LineSelection,
} from "./diff-reference";

export type CopyRows =
  | { mode: "split"; rows: readonly DiffRow[] }
  | { mode: "unified"; rows: readonly UnifiedRow[] };

export interface SelectionCopyOptions {
  path: string;
  beforePath: string;
  base: string | null;
  source: CopyRows;
  onCopied: (message: string) => void;
}

const CODE_CELL = ".code-review-diff-code";

export function copyToClipboard(
  text: string,
  message: string,
  onCopied: (message: string) => void,
): void {
  writeText(text).then(
    () => onCopied(message),
    () => onCopied("Could not copy to the clipboard"),
  );
}

export function wireSelectionCopy(grid: HTMLElement, options: SelectionCopyOptions): void {
  let side: string | null = null;
  grid.addEventListener("mousedown", (event) => {
    const cell =
      event.target instanceof Element ? event.target.closest<HTMLElement>(CODE_CELL) : null;
    side = cell?.dataset.side ?? null;
    if (side === "left" || side === "right") grid.dataset.selectSide = side;
    else delete grid.dataset.selectSide;
  });
  grid.addEventListener("mouseup", () => {
    const selection = window.getSelection();
    if (!side || !selection || selection.isCollapsed || !selection.toString().trim()) return;
    const indexes = [...grid.querySelectorAll<HTMLElement>(CODE_CELL)]
      .filter((cell) => cell.dataset.side === side && selection.containsNode(cell, true))
      .map((cell) => Number(cell.dataset.index));
    if (indexes.length === 0) return;
    const from = Math.min(...indexes);
    const to = Math.max(...indexes);
    const lines = selectedLines(options.source, side, from, to);
    if (!lines) return;
    const path = lines.side === "before" ? options.beforePath : options.path;
    const reference = formatReference(path, lines, options.base);
    copyToClipboard(reference, `Copied ${reference.split("\n")[0]}`, options.onCopied);
  });
}

function selectedLines(
  source: CopyRows,
  side: string,
  from: number,
  to: number,
): LineSelection | null {
  if (source.mode === "unified") return unifiedSelection(source.rows, from, to);
  return sideSelection(source.rows, side === "left" ? "left" : "right", from, to);
}

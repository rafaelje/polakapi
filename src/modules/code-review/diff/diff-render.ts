import { el } from "../dom";
import { diffSideLabels } from "../code-review-model";
import type { DiffTarget } from "../types";
import {
  foldRows,
  type DiffLine,
  type DiffRow,
  type FoldItem,
  type TextRange,
  type UnifiedRow,
} from "./diff-model";
import { markChanges, plainLine, type HighlightedLine } from "./highlight";

export type DiffMode = "split" | "unified";

export interface SideHighlights {
  left: HighlightedLine[] | null;
  right: HighlightedLine[] | null;
}

export interface DiffRenderInput {
  file: DiffTarget;
  highlights: SideHighlights;
  expanded: ReadonlySet<number>;
  onExpand: (start: number) => void;
}

export function renderSideBySide(input: DiffRenderInput, rows: readonly DiffRow[]): HTMLElement {
  const { file, highlights } = input;
  const grid = el("div", "code-review-diff-grid");
  const [beforeLabel, afterLabel] = diffSideLabels(file.source);
  const fragment = document.createDocumentFragment();
  fragment.append(
    sideTitle(
      rows.some((row) => row.left)
        ? `${beforeLabel} · ${file.originalPath ?? file.path}`
        : "(new file)",
    ),
    sideTitle(rows.some((row) => row.right) ? `${afterLabel} · ${file.path}` : "(deleted)"),
  );
  appendItems(fragment, input, foldRows(rows, input.expanded), (index) => {
    const row = rows[index];
    const leftKind = row.kind === "context" ? "context" : row.left ? "deleted" : "empty";
    const rightKind = row.kind === "context" ? "context" : row.right ? "added" : "empty";
    return [
      numberCell(row.left?.number, leftKind),
      codeCell(row.left, leftKind, highlights.left, "left", index),
      numberCell(row.right?.number, rightKind),
      codeCell(row.right, rightKind, highlights.right, "right", index),
    ];
  });
  grid.append(fragment);
  return grid;
}

export function renderUnified(input: DiffRenderInput, rows: readonly UnifiedRow[]): HTMLElement {
  const { highlights } = input;
  const grid = el("div", "code-review-diff-grid is-unified");
  const fragment = document.createDocumentFragment();
  appendItems(fragment, input, foldRows(rows, input.expanded), (index) => {
    const row = rows[index];
    const deleted = row.kind === "deleted";
    const number = deleted ? row.oldNumber : row.newNumber;
    const line = number === null ? null : { number, text: row.text, changes: row.changes };
    return [
      numberCell(row.oldNumber ?? undefined, row.kind),
      numberCell(row.newNumber ?? undefined, row.kind),
      codeCell(line, row.kind, deleted ? highlights.left : highlights.right, "unified", index),
    ];
  });
  grid.append(fragment);
  return grid;
}

function appendItems(
  target: DocumentFragment,
  input: DiffRenderInput,
  items: readonly FoldItem[],
  renderRow: (index: number) => HTMLElement[],
): void {
  for (const item of items) {
    if (item.kind === "row") {
      target.append(...renderRow(item.index));
      continue;
    }
    const count = item.end - item.start;
    const fold = el("button", "code-review-diff-fold", `⋯ Show ${count} unchanged lines`);
    fold.type = "button";
    fold.addEventListener("click", () => input.onExpand(item.start));
    target.append(fold);
  }
}

function sideTitle(text: string): HTMLElement {
  return el("div", "code-review-diff-side-title", text);
}

function numberCell(number: number | undefined, kind: string): HTMLElement {
  const cell = el("span", "code-review-diff-num", number === undefined ? "" : String(number));
  cell.dataset.kind = kind;
  return cell;
}

function codeCell(
  line: DiffLine | null,
  kind: string,
  highlighted: HighlightedLine[] | null,
  side: "left" | "right" | "unified",
  index: number,
): HTMLElement {
  const code = el("span", "code-review-diff-code");
  code.dataset.kind = kind;
  code.dataset.side = side;
  code.dataset.index = String(index);
  if (line) {
    const segments = highlighted?.[line.number - 1] ?? plainLine(line.text);
    code.append(renderSegments(segments, line.changes ?? []));
  }
  return code;
}

function renderSegments(line: HighlightedLine, changes: readonly TextRange[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const segment of markChanges(line, changes)) {
    const classes = [...segment.classes, ...(segment.changed ? ["code-review-diff-word"] : [])];
    if (classes.length === 0) fragment.append(segment.text);
    else fragment.append(el("span", classes.join(" "), segment.text));
  }
  return fragment;
}

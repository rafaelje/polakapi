import { el } from "../dom";
import { diffSideLabels } from "../code-review-model";
import type { DiffTarget } from "../types";
import type { DiffLine, DiffRow } from "./diff-model";
import { plainLine, type HighlightedLine } from "./highlight";

export interface SideHighlights {
  left: HighlightedLine[] | null;
  right: HighlightedLine[] | null;
}

export function renderSideBySide(
  file: DiffTarget,
  rows: readonly DiffRow[],
  highlights: SideHighlights,
): HTMLElement {
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
  for (const row of rows) {
    const leftKind = row.kind === "context" ? "context" : row.left ? "deleted" : "empty";
    const rightKind = row.kind === "context" ? "context" : row.right ? "added" : "empty";
    appendSide(fragment, row.left, leftKind, highlights.left);
    appendSide(fragment, row.right, rightKind, highlights.right);
  }
  grid.append(fragment);
  return grid;
}

function sideTitle(text: string): HTMLElement {
  return el("div", "code-review-diff-side-title", text);
}

function appendSide(
  target: DocumentFragment,
  line: DiffLine | null,
  kind: string,
  highlighted: HighlightedLine[] | null,
): void {
  const number = el("span", "code-review-diff-num", line ? String(line.number) : "");
  const code = el("span", "code-review-diff-code");
  if (line) code.append(renderSegments(highlighted?.[line.number - 1] ?? plainLine(line.text)));
  number.dataset.kind = kind;
  code.dataset.kind = kind;
  target.append(number, code);
}

function renderSegments(line: HighlightedLine): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const segment of line) {
    if (segment.classes.length === 0) fragment.append(segment.text);
    else fragment.append(el("span", segment.classes.join(" "), segment.text));
  }
  return fragment;
}

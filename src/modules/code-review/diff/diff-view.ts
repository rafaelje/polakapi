import { describeError, fetchFileContents } from "../api";
import { diffSideLabels } from "../code-review-model";
import { el, renderEmpty } from "../dom";
import type { DiffTarget } from "../types";
import { diffContents, type DiffLine, type DiffRow, type FileDiff } from "./diff-model";

export interface DiffView {
  show(file: DiffTarget | null, reload?: boolean): void;
}

type DiffState = { kind: "loading" } | { kind: "error"; message: string } | FileDiff;

export function mountDiffView(
  container: HTMLElement,
  projectPath: string,
  isVisible: () => boolean,
): DiffView {
  let currentKey: string | null = null;
  let state: DiffState = { kind: "loading" };
  let requestId = 0;

  const load = async (file: DiffTarget): Promise<void> => {
    const current = ++requestId;
    let next: DiffState;
    try {
      next = diffContents(await fetchFileContents(projectPath, file));
    } catch (cause) {
      next = { kind: "error", message: `Could not read the diff: ${describeError(cause)}` };
    }
    if (current !== requestId || currentKey !== file.key) return;
    state = next;
    if (isVisible()) renderFileDiff(container, file, state);
  };

  return {
    show: (file, reload = false) => {
      if (!file) {
        currentKey = null;
        requestId++;
        renderEmpty(container, "Select a file to see its diff.");
        return;
      }
      const key = file.key;
      if (key !== currentKey) {
        currentKey = key;
        state = { kind: "loading" };
        void load(file);
      } else if (reload) {
        void load(file);
      }
      renderFileDiff(container, file, state);
    },
  };
}

function renderFileDiff(container: HTMLElement, file: DiffTarget, state: DiffState): void {
  const body = (() => {
    switch (state.kind) {
      case "loading":
        return el("p", "code-review-empty", "Loading diff…");
      case "error":
        return el("p", "code-review-empty code-review-error", state.message);
      case "placeholder":
        return el("p", "code-review-empty", state.message);
      case "rows":
        return state.rows.length === 0
          ? el("p", "code-review-empty", "No content changes.")
          : renderRows(file, state.rows);
    }
  })();
  container.replaceChildren(renderHeader(file), body);
}

function renderHeader(file: DiffTarget): HTMLElement {
  const header = el("div", "code-review-diff-header");
  if (file.originalPath) {
    header.append(
      el("strong", "code-review-diff-path", file.originalPath),
      el("span", "code-review-muted", "→"),
    );
  }
  header.append(
    el("strong", "code-review-diff-path", file.path),
    el("span", "code-review-muted", `${sourceLabel(file)} · ${file.status}`),
  );
  return header;
}

function renderRows(file: DiffTarget, rows: readonly DiffRow[]): HTMLElement {
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
    appendSide(fragment, row.left, leftKind);
    appendSide(fragment, row.right, rightKind);
  }
  grid.append(fragment);
  return grid;
}

function sourceLabel(file: DiffTarget): string {
  return file.source.kind === "branch" ? `vs ${file.source.base}` : file.source.kind;
}

function sideTitle(text: string): HTMLElement {
  return el("div", "code-review-diff-side-title", text);
}

function appendSide(target: DocumentFragment, line: DiffLine | null, kind: string): void {
  const number = el("span", "code-review-diff-num", line ? String(line.number) : "");
  const code = el("span", "code-review-diff-code", line?.text ?? "");
  number.dataset.kind = kind;
  code.dataset.kind = kind;
  target.append(number, code);
}

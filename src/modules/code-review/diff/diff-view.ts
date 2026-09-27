import { describeError, fetchFileContents } from "../api";
import { el, renderEmpty } from "../dom";
import type { DiffTarget, FileContents, SideContent } from "../types";
import { diffContents, type FileDiff } from "./diff-model";
import { renderSideBySide, type SideHighlights } from "./diff-render";
import { highlightFile } from "./highlight";

export interface DiffView {
  show(file: DiffTarget | null, reload?: boolean): void;
}

type DiffState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | (FileDiff & { highlights?: SideHighlights });

const MAX_HIGHLIGHT_CHARS = 256 * 1024;

export function mountDiffView(
  container: HTMLElement,
  projectPath: string,
  isVisible: () => boolean,
): DiffView {
  let currentKey: string | null = null;
  let state: DiffState = { kind: "loading" };
  let requestId = 0;

  const isCurrent = (current: number, file: DiffTarget): boolean =>
    current === requestId && currentKey === file.key;

  const load = async (file: DiffTarget): Promise<void> => {
    const current = ++requestId;
    let contents: FileContents | null = null;
    let next: DiffState;
    try {
      contents = await fetchFileContents(projectPath, file);
      next = diffContents(contents);
    } catch (cause) {
      next = { kind: "error", message: `Could not read the diff: ${describeError(cause)}` };
    }
    if (!isCurrent(current, file)) return;
    state = next;
    if (isVisible()) renderFileDiff(container, file, state);
    if (!contents || state.kind !== "rows") return;

    await new Promise((resolve) => setTimeout(resolve));
    if (!isCurrent(current, file) || state.kind !== "rows") return;
    state = { ...state, highlights: highlightSides(file, contents) };
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

function highlightSides(file: DiffTarget, contents: FileContents): SideHighlights {
  const highlight = (side: SideContent, path: string) =>
    side.kind === "text" && side.text.length <= MAX_HIGHLIGHT_CHARS
      ? highlightFile(side.text, path)
      : null;
  return {
    left: highlight(contents.before, file.originalPath ?? file.path),
    right: highlight(contents.after, file.path),
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
          : renderSideBySide(file, state.rows, state.highlights ?? { left: null, right: null });
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

function sourceLabel(file: DiffTarget): string {
  return file.source.kind === "branch" ? `vs ${file.source.base}` : file.source.kind;
}

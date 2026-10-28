import { fetchFileContents } from "../api";
import { el, renderEmpty } from "../dom";
import type { DiffTarget, FileContents, SideContent } from "../types";
import {
  diffContents,
  unifiedRows,
  type DiffRow,
  type FileDiff,
  type UnifiedRow,
} from "./diff-model";
import {
  renderSideBySide,
  renderUnified,
  type DiffMode,
  type DiffRenderInput,
  type SideHighlights,
} from "./diff-render";
import { copyToClipboard, wireSelectionCopy } from "./diff-copy";
import { highlightFile } from "./highlight";
import { stringifyError } from "../../../shared/errors";

export interface DiffView {
  show(file: DiffTarget | null, reload?: boolean): void;
}

type DiffState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "placeholder"; message: string }
  | { kind: "rows"; rows: DiffRow[]; unified?: UnifiedRow[]; highlights?: SideHighlights };

const MAX_HIGHLIGHT_CHARS = 256 * 1024;
const NO_HIGHLIGHTS: SideHighlights = { left: null, right: null };

let mode: DiffMode = "split";

export function mountDiffView(
  container: HTMLElement,
  projectPath: string,
  isVisible: () => boolean,
): DiffView {
  let currentKey: string | null = null;
  let state: DiffState = { kind: "loading" };
  let requestId = 0;
  let expanded = new Set<number>();
  let shownFile: DiffTarget | null = null;
  let loaded: FileContents | null = null;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const copied = el("span", "code-review-diff-copied");
  copied.setAttribute("role", "status");
  const onCopied = (message: string): void => {
    copied.textContent = message;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.textContent = ""), 1800);
  };

  const render = (file: DiffTarget): void => {
    const scrollTop = container.scrollTop;
    const sameFile = shownFile !== null && shownFile.key === file.key;
    shownFile = file;
    renderFileDiff(container, file, state, {
      expanded,
      base: file.source.kind === "branch" ? file.source.base : null,
      copied,
      onCopied,
      onExpand: (start) => {
        expanded = new Set(expanded).add(start);
        render(file);
      },
      onToggleMode: () => {
        mode = mode === "split" ? "unified" : "split";
        expanded = new Set();
        render(file);
      },
    });
    if (sameFile) container.scrollTop = scrollTop;
  };

  const isCurrent = (current: number, file: DiffTarget): boolean =>
    current === requestId && currentKey === file.key;

  const load = async (file: DiffTarget): Promise<void> => {
    const current = ++requestId;
    let contents: FileContents | null = null;
    let next: FileDiff | { kind: "error"; message: string };
    try {
      contents = await fetchFileContents(projectPath, file);
      next = diffContents(contents);
    } catch (cause) {
      next = { kind: "error", message: `Could not read the diff: ${stringifyError(cause)}` };
    }
    if (!isCurrent(current, file)) return;
    const unchanged = contents && loaded && sameContents(contents, loaded);
    if (unchanged && state.kind === "rows" && state.highlights) return;
    loaded = contents;
    state = next;
    if (isVisible()) render(file);
    if (!contents || state.kind !== "rows") return;

    await new Promise((resolve) => setTimeout(resolve));
    if (!isCurrent(current, file) || state.kind !== "rows") return;
    state = { ...state, highlights: highlightSides(file, contents) };
    if (isVisible()) render(file);
  };

  return {
    show: (file, reload = false) => {
      if (!file) {
        currentKey = null;
        shownFile = null;
        requestId++;
        renderEmpty(container, "Select a file to see its diff.");
        return;
      }
      const key = file.key;
      if (key !== currentKey) {
        currentKey = key;
        state = { kind: "loading" };
        loaded = null;
        expanded = new Set();
        void load(file);
      } else if (reload) {
        void load(file);
      }
      render(file);
    },
  };
}

function sameContents(a: FileContents, b: FileContents): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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

interface ViewControls {
  expanded: ReadonlySet<number>;
  base: string | null;
  copied: HTMLElement;
  onCopied: (message: string) => void;
  onExpand: (start: number) => void;
  onToggleMode: () => void;
}

function renderFileDiff(
  container: HTMLElement,
  file: DiffTarget,
  state: DiffState,
  controls: ViewControls,
): void {
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
          : renderRows(file, state, controls);
    }
  })();
  container.replaceChildren(renderHeader(file, controls), body);
}

function renderRows(
  file: DiffTarget,
  state: Extract<DiffState, { kind: "rows" }>,
  controls: ViewControls,
): HTMLElement {
  const input: DiffRenderInput = {
    file,
    highlights: state.highlights ?? NO_HIGHLIGHTS,
    expanded: controls.expanded,
    onExpand: controls.onExpand,
  };
  const copy = {
    path: file.path,
    beforePath: file.originalPath ?? file.path,
    base: controls.base,
    onCopied: controls.onCopied,
  };
  if (mode === "split") {
    const grid = renderSideBySide(input, state.rows);
    wireSelectionCopy(grid, { ...copy, source: { mode, rows: state.rows } });
    return grid;
  }
  state.unified ??= unifiedRows(state.rows);
  const grid = renderUnified(input, state.unified);
  wireSelectionCopy(grid, { ...copy, source: { mode, rows: state.unified } });
  return grid;
}

function renderHeader(file: DiffTarget, controls: ViewControls): HTMLElement {
  const header = el("div", "code-review-diff-header");
  if (file.originalPath) {
    header.append(
      el("strong", "code-review-diff-path", file.originalPath),
      el("span", "code-review-muted", "→"),
    );
  }
  const copyPath = el("button", "code-review-diff-copy-path", "Copy path");
  copyPath.type = "button";
  copyPath.title = "Copy the file path";
  copyPath.addEventListener("click", () =>
    copyToClipboard(file.path, `Copied ${file.path}`, controls.onCopied),
  );
  header.append(
    el("strong", "code-review-diff-path", file.path),
    copyPath,
    el("span", "code-review-muted", `${sourceLabel(file)} · ${file.status}`),
    controls.copied,
  );
  const toggle = el(
    "button",
    "code-review-btn code-review-diff-mode",
    mode === "split" ? "Unified" : "Side by side",
  );
  toggle.type = "button";
  toggle.title = "Switch between side-by-side and unified views";
  toggle.addEventListener("click", controls.onToggleMode);
  header.append(toggle);
  return header;
}

function sourceLabel(file: DiffTarget): string {
  return file.source.kind === "branch" ? `vs ${file.source.base}` : file.source.kind;
}

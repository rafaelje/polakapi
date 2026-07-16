import { makeFlexGutter } from "../layout/gutters";
import type { TerminalLayoutNode, TerminalLayoutPath } from "./terminal-layout";
import type { TerminalPane } from "./terminal-pane";

export interface TerminalSplitLayoutOptions {
  refit(): void;
  onRatioChange(path: TerminalLayoutPath, ratio: number): void;
}

export function layoutTerminalSplits(
  grid: HTMLElement,
  layout: TerminalLayoutNode | null,
  panes: ReadonlyMap<string, TerminalPane>,
  options: TerminalSplitLayoutOptions,
): void {
  for (const pane of panes.values()) pane.el.remove();
  grid.replaceChildren();
  if (layout) grid.append(renderNode(layout, [], panes, options));
  requestAnimationFrame(() => options.refit());
}

function renderNode(
  layout: TerminalLayoutNode,
  path: TerminalLayoutPath,
  panes: ReadonlyMap<string, TerminalPane>,
  options: TerminalSplitLayoutOptions,
): HTMLElement {
  if (layout.type === "pane") {
    const pane = panes.get(layout.paneId);
    if (!pane) return missingPaneNode();
    pane.el.style.flex = "1 1 0px";
    return pane.el;
  }

  const split = document.createElement("div");
  split.className = `terminal-split terminal-split--${layout.axis}`;
  split.dataset.splitPath = path.join(".");
  const first = renderNode(layout.first, [...path, "first"], panes, options);
  const second = renderNode(layout.second, [...path, "second"], panes, options);
  first.style.flex = `${layout.ratio} 1 0px`;
  second.style.flex = `${1 - layout.ratio} 1 0px`;
  const gutter = makeFlexGutter(
    layout.axis === "row" ? "h" : "v",
    () => options.refit(),
    (ratio) => options.onRatioChange(path, ratio),
  );
  split.append(first, gutter, second);
  return split;
}

function missingPaneNode(): HTMLElement {
  const node = document.createElement("div");
  node.className = "terminal-pane-missing";
  return node;
}

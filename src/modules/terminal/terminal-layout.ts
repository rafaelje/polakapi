export type TerminalDockPosition = "top" | "bottom" | "left" | "right";
export type TerminalSplitAxis = "row" | "column";
export type TerminalLayoutPath = readonly ("first" | "second")[];

export interface TerminalPaneLayout {
  type: "pane";
  paneId: string;
}

export interface TerminalSplitLayout {
  type: "split";
  axis: TerminalSplitAxis;
  ratio: number;
  first: TerminalLayoutNode;
  second: TerminalLayoutNode;
}

export type TerminalLayoutNode = TerminalPaneLayout | TerminalSplitLayout;

const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

export function terminalPaneLayout(paneId: string): TerminalPaneLayout {
  return { type: "pane", paneId };
}

export function terminalLayoutPaneIds(layout: TerminalLayoutNode | null): string[] {
  if (!layout) return [];
  if (layout.type === "pane") return [layout.paneId];
  return [...terminalLayoutPaneIds(layout.first), ...terminalLayoutPaneIds(layout.second)];
}

export function createDefaultTerminalLayout(paneIds: readonly string[]): TerminalLayoutNode | null {
  const uniqueIds = [...new Set(paneIds.filter(Boolean))];
  const rows: TerminalLayoutNode[] = [];
  for (let index = 0; index < uniqueIds.length; index += 2) {
    const first = terminalPaneLayout(uniqueIds[index]);
    const secondId = uniqueIds[index + 1];
    rows.push(secondId ? splitLayout("row", first, terminalPaneLayout(secondId)) : first);
  }
  return combineNodes("column", rows);
}

export function appendTerminalPane(
  layout: TerminalLayoutNode | null,
  paneId: string,
  targetId?: string | null,
): TerminalLayoutNode {
  if (!layout) return terminalPaneLayout(paneId);
  if (terminalLayoutPaneIds(layout).includes(paneId)) return layout;
  if (targetId && terminalLayoutPaneIds(layout).includes(targetId)) {
    return insertByTarget(layout, targetId, terminalPaneLayout(paneId), "right") ?? layout;
  }
  return splitLayout("row", layout, terminalPaneLayout(paneId));
}

export function removeTerminalPane(
  layout: TerminalLayoutNode | null,
  paneId: string,
): TerminalLayoutNode | null {
  if (!layout) return null;
  if (layout.type === "pane") return layout.paneId === paneId ? null : layout;
  const first = removeTerminalPane(layout.first, paneId);
  const second = removeTerminalPane(layout.second, paneId);
  if (!first) return second;
  if (!second) return first;
  if (first === layout.first && second === layout.second) return layout;
  return { ...layout, first, second };
}

export function replaceTerminalPaneId(
  layout: TerminalLayoutNode | null,
  previousId: string,
  nextId: string,
): TerminalLayoutNode | null {
  if (!layout || previousId === nextId) return layout;
  if (layout.type === "pane") {
    return layout.paneId === previousId ? terminalPaneLayout(nextId) : layout;
  }
  const first = replaceTerminalPaneId(layout.first, previousId, nextId);
  const second = replaceTerminalPaneId(layout.second, previousId, nextId);
  if (!first || !second) return first ?? second;
  if (first === layout.first && second === layout.second) return layout;
  return { ...layout, first, second };
}

export function dockTerminalPane(
  layout: TerminalLayoutNode | null,
  sourceId: string,
  targetId: string,
  position: TerminalDockPosition,
): TerminalLayoutNode | null {
  if (!layout || sourceId === targetId) return layout;
  const ids = terminalLayoutPaneIds(layout);
  if (!ids.includes(sourceId) || !ids.includes(targetId)) return layout;
  const withoutSource = removeTerminalPane(layout, sourceId);
  if (!withoutSource) return layout;
  return insertByTarget(withoutSource, targetId, terminalPaneLayout(sourceId), position) ?? layout;
}

export function dockTerminalPaneAtRoot(
  layout: TerminalLayoutNode | null,
  sourceId: string,
  position: TerminalDockPosition,
): TerminalLayoutNode | null {
  if (!layout || terminalLayoutPaneIds(layout).length < 2) return layout;
  const withoutSource = removeTerminalPane(layout, sourceId);
  if (!withoutSource || withoutSource === layout) return layout;
  const source = terminalPaneLayout(sourceId);
  const axis = axisForPosition(position);
  return isLeadingPosition(position)
    ? splitLayout(axis, source, withoutSource)
    : splitLayout(axis, withoutSource, source);
}

export function updateTerminalSplitRatio(
  layout: TerminalLayoutNode | null,
  path: TerminalLayoutPath,
  ratio: number,
): TerminalLayoutNode | null {
  if (!layout || layout.type !== "split") return layout;
  if (path.length === 0) return { ...layout, ratio: clampRatio(ratio) };
  const [head, ...tail] = path;
  const child = updateTerminalSplitRatio(layout[head], tail, ratio);
  if (!child || child === layout[head]) return layout;
  return { ...layout, [head]: child };
}

export function repairTerminalLayout(
  value: unknown,
  livePaneIds: readonly string[],
  idMap?: ReadonlyMap<string, string>,
): TerminalLayoutNode | null {
  const liveIds = [...new Set(livePaneIds.filter(Boolean))];
  const valid = new Set(liveIds);
  const seen = new Set<string>();
  let repaired = readLayout(value, valid, seen, idMap);
  for (const paneId of liveIds) {
    if (!seen.has(paneId)) repaired = appendTerminalPane(repaired, paneId);
  }
  return repaired;
}

export function terminalLayoutsEqual(
  left: TerminalLayoutNode | null | undefined,
  right: TerminalLayoutNode | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.type !== right.type) return false;
  if (left.type === "pane" && right.type === "pane") return left.paneId === right.paneId;
  if (left.type !== "split" || right.type !== "split") return false;
  return (
    left.axis === right.axis &&
    left.ratio === right.ratio &&
    terminalLayoutsEqual(left.first, right.first) &&
    terminalLayoutsEqual(left.second, right.second)
  );
}

function insertByTarget(
  layout: TerminalLayoutNode,
  targetId: string,
  source: TerminalPaneLayout,
  position: TerminalDockPosition,
): TerminalLayoutNode | null {
  if (layout.type === "pane") {
    if (layout.paneId !== targetId) return null;
    const axis = axisForPosition(position);
    return isLeadingPosition(position)
      ? splitLayout(axis, source, layout)
      : splitLayout(axis, layout, source);
  }
  const first = insertByTarget(layout.first, targetId, source, position);
  if (first) return { ...layout, first };
  const second = insertByTarget(layout.second, targetId, source, position);
  return second ? { ...layout, second } : null;
}

function readLayout(
  value: unknown,
  valid: ReadonlySet<string>,
  seen: Set<string>,
  idMap?: ReadonlyMap<string, string>,
): TerminalLayoutNode | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (node.type === "pane" && typeof node.paneId === "string") {
    const paneId = idMap?.get(node.paneId) ?? node.paneId;
    if (!valid.has(paneId) || seen.has(paneId)) return null;
    seen.add(paneId);
    return terminalPaneLayout(paneId);
  }
  if (node.type !== "split" || (node.axis !== "row" && node.axis !== "column")) return null;
  const first = readLayout(node.first, valid, seen, idMap);
  const second = readLayout(node.second, valid, seen, idMap);
  if (!first) return second;
  if (!second) return first;
  const ratio = typeof node.ratio === "number" ? node.ratio : DEFAULT_RATIO;
  return splitLayout(node.axis, first, second, ratio);
}

function splitLayout(
  axis: TerminalSplitAxis,
  first: TerminalLayoutNode,
  second: TerminalLayoutNode,
  ratio = DEFAULT_RATIO,
): TerminalSplitLayout {
  return { type: "split", axis, ratio: clampRatio(ratio), first, second };
}

function combineNodes(
  axis: TerminalSplitAxis,
  nodes: readonly TerminalLayoutNode[],
): TerminalLayoutNode | null {
  if (nodes.length === 0) return null;
  return nodes
    .slice(1)
    .reduce<TerminalLayoutNode>((layout, node) => splitLayout(axis, layout, node), nodes[0]);
}

function axisForPosition(position: TerminalDockPosition): TerminalSplitAxis {
  return position === "left" || position === "right" ? "row" : "column";
}

function isLeadingPosition(position: TerminalDockPosition): boolean {
  return position === "left" || position === "top";
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RATIO;
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
}

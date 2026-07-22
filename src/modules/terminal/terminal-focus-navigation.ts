export type FocusDirection = "left" | "right" | "up" | "down";

export interface PaneBox {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const EDGE_TOLERANCE_PX = 2;

export function paneBoxes(
  order: readonly string[],
  getEl: (id: string) => HTMLElement | undefined,
): PaneBox[] {
  const boxes: PaneBox[] = [];
  for (const id of order) {
    const el = getEl(id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    boxes.push({ id, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  }
  return boxes;
}

export function resolveDirectionalFocus(
  panes: readonly PaneBox[],
  focusedId: string | null,
  direction: FocusDirection,
): string | null {
  if (panes.length === 0) return null;
  const focused = panes.find((p) => p.id === focusedId);
  if (!focused) return panes[0].id;

  let best: { id: string; overlaps: boolean; gap: number; perp: number } | null = null;
  for (const candidate of panes) {
    if (candidate.id === focused.id) continue;
    const gap = axialGap(focused, candidate, direction);
    if (gap < -EDGE_TOLERANCE_PX) continue;
    const overlap = perpendicularOverlap(focused, candidate, direction);
    const entry = {
      id: candidate.id,
      overlaps: overlap > 0,
      gap: Math.max(0, gap),
      perp: perpendicularCenterDistance(focused, candidate, direction),
    };
    if (!best || isBetter(entry, best)) best = entry;
  }
  return best?.id ?? null;
}

function isBetter(a: { overlaps: boolean; gap: number; perp: number }, b: typeof a): boolean {
  if (a.overlaps !== b.overlaps) return a.overlaps;
  if (a.gap !== b.gap) return a.gap < b.gap;
  return a.perp < b.perp;
}

function axialGap(focused: PaneBox, candidate: PaneBox, direction: FocusDirection): number {
  switch (direction) {
    case "left":
      return focused.left - candidate.right;
    case "right":
      return candidate.left - focused.right;
    case "up":
      return focused.top - candidate.bottom;
    case "down":
      return candidate.top - focused.bottom;
  }
}

function perpendicularOverlap(
  focused: PaneBox,
  candidate: PaneBox,
  direction: FocusDirection,
): number {
  if (direction === "left" || direction === "right") {
    return Math.min(focused.bottom, candidate.bottom) - Math.max(focused.top, candidate.top);
  }
  return Math.min(focused.right, candidate.right) - Math.max(focused.left, candidate.left);
}

function perpendicularCenterDistance(
  focused: PaneBox,
  candidate: PaneBox,
  direction: FocusDirection,
): number {
  if (direction === "left" || direction === "right") {
    return Math.abs((focused.top + focused.bottom) / 2 - (candidate.top + candidate.bottom) / 2);
  }
  return Math.abs((focused.left + focused.right) / 2 - (candidate.left + candidate.right) / 2);
}

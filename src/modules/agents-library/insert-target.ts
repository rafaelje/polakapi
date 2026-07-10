// Structural interfaces so this resolver stays unit-testable without a
// live TerminalRouter / TerminalManager. Mirrors the `PaneLookup` pattern
// used by terminal-drop.ts.

export interface TerminalManagerLookup {
  readonly focusedPaneId: string | null;
  ids(): string[];
  get(id: string): unknown;
  isLive(id: string): boolean;
}

export interface TerminalRouterLookup {
  getActive(): TerminalManagerLookup | null;
}

export interface InsertTarget {
  ptyId: string;
  paneLabel: string;
}

/**
 * Picks a pane to insert into. Prefers the focused pane; falls back to the
 * first live pane in creation order. Dead panes (failed spawns, exited
 * processes) are skipped — writing to their synthetic ptyIds fails on the
 * backend with "unknown pty".
 */
export function resolveInsertTarget(router: TerminalRouterLookup): InsertTarget | null {
  const manager = router.getActive();
  if (!manager) return null;
  const ids = manager.ids();
  const focused = manager.focusedPaneId;
  const pick =
    focused && manager.isLive(focused) ? focused : (ids.find((id) => manager.isLive(id)) ?? null);
  if (!pick) return null;
  if (!manager.get(pick)) return null;
  const idx = ids.indexOf(pick);
  return { ptyId: pick, paneLabel: `pane ${idx + 1}` };
}

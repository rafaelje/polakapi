import type { TerminalPane } from "./terminal-pane";
import type { PaneSnapshots } from "./types";

/** What every pane of a grid shows, for another window to take them over. */
export async function snapshotPanes(grid: {
  ids(): string[];
  get(id: string): TerminalPane | undefined;
}): Promise<PaneSnapshots> {
  const entries = await Promise.all(
    grid.ids().map(async (id) => [id, await grid.get(id)?.snapshot()] as const),
  );
  const out: PaneSnapshots = {};
  for (const [id, snapshot] of entries) if (snapshot) out[id] = snapshot;
  return out;
}

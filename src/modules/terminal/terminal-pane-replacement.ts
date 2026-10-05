import { replaceTerminalPaneId, type TerminalLayoutNode } from "./terminal-layout";
import type { TerminalPane } from "./terminal-pane";

export async function replacePaneSlot(
  paneId: string,
  state: { order: string[]; layout: TerminalLayoutNode | null },
  close: () => Promise<void>,
  add: () => Promise<TerminalPane | null>,
  apply: (layout: TerminalLayoutNode | null, newId: string) => void,
): Promise<string | null> {
  const targetIdx = state.order.indexOf(paneId);
  const preservedLayout = state.layout;
  await close();
  const pane = await add();
  if (!pane) return null;
  const newId = pane.ptyId || state.order[state.order.length - 1];
  if (newId && targetIdx >= 0) {
    const fromIdx = state.order.indexOf(newId);
    if (fromIdx >= 0 && fromIdx !== targetIdx) {
      state.order.splice(fromIdx, 1);
      state.order.splice(targetIdx, 0, newId);
    }
    apply(replaceTerminalPaneId(preservedLayout, paneId, newId), newId);
  }
  return newId || null;
}

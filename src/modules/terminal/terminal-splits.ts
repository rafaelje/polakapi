import type { TerminalManager } from "./terminal-manager";

export async function splitFocusedTerminal(
  manager: TerminalManager,
  position: "right" | "bottom",
): Promise<void> {
  const pane = await manager.addPane(undefined, { splitPosition: position });
  const id = pane?.el.dataset.ptyId;
  if (id && manager.focusedPaneId === id) manager.setFocus(id, true);
}

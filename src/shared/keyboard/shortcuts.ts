export interface ShortcutHandlers {
  newPane: () => void;
  closeFocused: () => void;
  focusByIndex: (idx: number) => void;
  focusPrev: () => void;
  focusNext: () => void;
  /** F4: Cmd-P / Ctrl-P → toggle the global command palette. */
  togglePalette: () => void;
}

/**
 * Returns true if the platform-conventional command/meta key for the host OS is held.
 * On macOS that's ⌘ (metaKey); on others, Ctrl.
 */
function isCmdHeld(e: KeyboardEvent): boolean {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export function wireShortcuts(handlers: ShortcutHandlers): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (!isCmdHeld(e)) return;

    // Cmd+T → new terminal
    if (e.key.toLowerCase() === "t" && !e.shiftKey) {
      e.preventDefault();
      handlers.newPane();
      return;
    }
    // Cmd+W → close focused
    if (e.key.toLowerCase() === "w" && !e.shiftKey) {
      e.preventDefault();
      handlers.closeFocused();
      return;
    }
    // Cmd+P → toggle command palette. Cmd-P is the browser/webview print
    // shortcut so we MUST preventDefault before the OS panel surfaces.
    if (e.key.toLowerCase() === "p" && !e.shiftKey) {
      e.preventDefault();
      handlers.togglePalette();
      return;
    }
    // Cmd+[ / Cmd+] → prev/next
    if (e.key === "[") {
      e.preventDefault();
      handlers.focusPrev();
      return;
    }
    if (e.key === "]") {
      e.preventDefault();
      handlers.focusNext();
      return;
    }
    // Cmd+1..9 → focus by index
    if (e.key >= "1" && e.key <= "9") {
      e.preventDefault();
      handlers.focusByIndex(Number(e.key) - 1);
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

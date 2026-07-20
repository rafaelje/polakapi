export interface ShortcutHandlers {
  newPane: () => void;
  closeFocused: () => void;
  focusByIndex: (idx: number) => void;
  focusPrev: () => void;
  focusNext: () => void;
  /** Cmd/Ctrl+Shift+Arrow → focus the nearest pane in that screen direction. */
  focusDirection: (direction: "left" | "right" | "up" | "down") => void;
  /** Cmd-P / Ctrl-Shift-P → toggle the global command palette. */
  togglePalette: () => void;
}

export type AppShortcut =
  | { kind: "new-pane" }
  | { kind: "close-focused" }
  | { kind: "toggle-palette" }
  | { kind: "focus-prev" }
  | { kind: "focus-next" }
  | { kind: "focus-index"; index: number }
  | { kind: "focus-direction"; direction: "left" | "right" | "up" | "down" };

/** The KeyboardEvent surface the resolver reads — narrow so tests can stub it. */
export interface ShortcutKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const ARROW_DIRECTIONS: Record<string, "left" | "right" | "up" | "down"> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

export function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

/**
 * Maps a keydown to an app-level action, or null when the app should stay out
 * of the way.
 *
 * macOS uses ⌘ (which terminals never consume, so plain Cmd+T/W/P/[ /]/digits
 * are safe). Everywhere else the modifier is Ctrl+Shift — plain Ctrl combos
 * belong to the shell running inside the pane (Ctrl+W = kill-word, Ctrl+T =
 * transpose, Ctrl+[ = Escape…), same convention as GNOME Terminal / VS Code.
 * Shifted digits and brackets are matched by physical key (`e.code`) since
 * their `e.key` value is layout-dependent.
 */
export function resolveAppShortcut(e: ShortcutKeyEvent, isMac: boolean): AppShortcut | null {
  if (e.altKey) return null;
  const cmdHeld = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!cmdHeld) return null;

  // Cmd/Ctrl+Shift+Arrow → directional pane focus (both platforms).
  const direction = e.shiftKey ? ARROW_DIRECTIONS[e.key] : undefined;
  if (direction) return { kind: "focus-direction", direction };

  if (isMac) {
    if (e.shiftKey) return null;
    if (e.key.toLowerCase() === "t") return { kind: "new-pane" };
    if (e.key.toLowerCase() === "w") return { kind: "close-focused" };
    if (e.key.toLowerCase() === "p") return { kind: "toggle-palette" };
    if (e.key === "[") return { kind: "focus-prev" };
    if (e.key === "]") return { kind: "focus-next" };
    if (e.key >= "1" && e.key <= "9") return { kind: "focus-index", index: Number(e.key) - 1 };
    return null;
  }

  if (!e.shiftKey) return null;
  if (e.key.toLowerCase() === "t") return { kind: "new-pane" };
  if (e.key.toLowerCase() === "w") return { kind: "close-focused" };
  if (e.key.toLowerCase() === "p") return { kind: "toggle-palette" };
  if (e.code === "BracketLeft") return { kind: "focus-prev" };
  if (e.code === "BracketRight") return { kind: "focus-next" };
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) return { kind: "focus-index", index: Number(digit[1]) - 1 };
  return null;
}

export function wireShortcuts(handlers: ShortcutHandlers): () => void {
  const isMac = isMacPlatform();
  const onKey = (e: KeyboardEvent): void => {
    const shortcut = resolveAppShortcut(e, isMac);
    if (!shortcut) return;
    // Capture phase + stopPropagation: xterm listens on its textarea and
    // cancels most Ctrl combos before they bubble, so the app must claim its
    // shortcuts before the event ever reaches the terminal.
    e.preventDefault();
    e.stopPropagation();
    switch (shortcut.kind) {
      case "new-pane":
        handlers.newPane();
        return;
      case "close-focused":
        handlers.closeFocused();
        return;
      case "toggle-palette":
        handlers.togglePalette();
        return;
      case "focus-prev":
        handlers.focusPrev();
        return;
      case "focus-next":
        handlers.focusNext();
        return;
      case "focus-index":
        handlers.focusByIndex(shortcut.index);
        return;
      case "focus-direction":
        handlers.focusDirection(shortcut.direction);
        return;
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}

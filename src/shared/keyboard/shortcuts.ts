export interface ShortcutHandlers {
  newPane: () => void;
  splitPane: (position: "right" | "bottom") => void;
  closeFocused: () => void;
  focusByIndex: (idx: number) => void;
  focusPrev: () => void;
  focusNext: () => void;
  focusDirection: (direction: "left" | "right" | "up" | "down") => void;
  togglePalette: () => void;
  toggleMenuBar: () => void;
}

export type AppShortcut =
  | { kind: "new-pane" }
  | { kind: "split-pane"; position: "right" | "bottom" }
  | { kind: "close-focused" }
  | { kind: "toggle-palette" }
  | { kind: "toggle-menu-bar" }
  | { kind: "focus-prev" }
  | { kind: "focus-next" }
  | { kind: "focus-index"; index: number }
  | { kind: "focus-direction"; direction: "left" | "right" | "up" | "down" };

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

export function resolveAppShortcut(e: ShortcutKeyEvent, isMac: boolean): AppShortcut | null {
  const cmdHeld = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!cmdHeld) return null;

  if (e.altKey) {
    const direction = isMac && !e.shiftKey ? ARROW_DIRECTIONS[e.key] : undefined;
    return direction ? { kind: "focus-direction", direction } : null;
  }

  const direction = e.shiftKey ? ARROW_DIRECTIONS[e.key] : undefined;
  if (direction) return { kind: "focus-direction", direction };

  if (isMac) {
    if (e.key.toLowerCase() === "d") {
      return { kind: "split-pane", position: e.shiftKey ? "bottom" : "right" };
    }
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
  if (e.key.toLowerCase() === "m") return { kind: "toggle-menu-bar" };
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
    e.preventDefault();
    e.stopPropagation();
    switch (shortcut.kind) {
      case "new-pane":
        handlers.newPane();
        return;
      case "split-pane":
        handlers.splitPane(shortcut.position);
        return;
      case "close-focused":
        handlers.closeFocused();
        return;
      case "toggle-palette":
        handlers.togglePalette();
        return;
      case "toggle-menu-bar":
        handlers.toggleMenuBar();
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

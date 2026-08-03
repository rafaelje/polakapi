import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export interface TerminalSelectionSource {
  element?: HTMLElement;
  getSelection(): string;
}

export function normalizeTerminalSelection(selection: string): string {
  return selection.normalize("NFC");
}

export function attachTerminalClipboard(source: TerminalSelectionSource): { dispose(): void } {
  const element = source.element;
  if (!element) return { dispose: () => {} };

  const onCopy = (event: ClipboardEvent): void => {
    const selection = source.getSelection();
    if (!selection || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", normalizeTerminalSelection(selection));
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  element.addEventListener("copy", onCopy, true);
  return {
    dispose: () => element.removeEventListener("copy", onCopy, true),
  };
}

// xterm moves its hidden textarea under the cursor on right-click so the
// webview's native menu can act on it; in WebKitGTK that menu can activate
// Paste on the same gesture, pasting straight into the shell. Suppress it.
export function attachTerminalContextMenuGuard(element: HTMLElement): { dispose(): void } {
  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  element.addEventListener("contextmenu", onContextMenu, true);
  return {
    dispose: () => element.removeEventListener("contextmenu", onContextMenu, true),
  };
}

export type CopyPasteAction = "copy" | "paste";

// Terminal-convention shortcuts: Ctrl+Shift+C / Ctrl+Shift+V.
export function resolveCopyPasteKey(event: KeyboardEvent): CopyPasteAction | null {
  if (event.type !== "keydown") return null;
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return null;
  const key = event.key.toLowerCase();
  if (key === "c") return "copy";
  if (key === "v") return "paste";
  return null;
}

interface CopyPasteTerminal {
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  getSelection(): string;
  paste(data: string): void;
}

// xterm swallows all keyboard input, so the webview never emits a native copy
// event for Ctrl+Shift+C — these must be handled explicitly. Clipboard IO
// goes through the Tauri plugin (Rust side) because WebKitGTK's async
// navigator.clipboard is unreliable (silent write failures, denied reads).
export function attachTerminalCopyPasteKeys(term: CopyPasteTerminal): void {
  term.attachCustomKeyEventHandler((event) => {
    const action = resolveCopyPasteKey(event);
    if (action === null) return true;
    event.preventDefault();
    if (action === "copy") {
      const text = normalizeTerminalSelection(term.getSelection());
      if (text) {
        void writeText(text).catch((error) => console.error("Clipboard copy failed", error));
      }
    } else {
      void readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch((error) => console.error("Clipboard paste failed", error));
    }
    return false;
  });
}

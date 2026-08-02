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
// event for Ctrl+Shift+C — these must be handled explicitly.
export function attachTerminalCopyPasteKeys(term: CopyPasteTerminal): void {
  term.attachCustomKeyEventHandler((event) => {
    const action = resolveCopyPasteKey(event);
    if (action === null) return true;
    event.preventDefault();
    if (action === "copy") {
      const text = normalizeTerminalSelection(term.getSelection());
      if (text) copyToClipboard(text);
    } else {
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {});
    }
    return false;
  });
}

function copyToClipboard(text: string): void {
  const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if (write) {
    // Fallback fires the copy event, which attachTerminalClipboard fills in.
    void write(text).catch(() => document.execCommand("copy"));
  } else {
    document.execCommand("copy");
  }
}

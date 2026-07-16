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

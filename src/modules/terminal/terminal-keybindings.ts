export interface TerminalKeybindingSource {
  element?: HTMLElement;
}

export function resolveTerminalKeyInput(event: KeyboardEvent): string | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;

  if (event.key === "ArrowLeft") return "\x01";
  if (event.key === "ArrowRight") return "\x05";
  return null;
}

export function attachTerminalKeybindings(
  source: TerminalKeybindingSource,
  write: (data: string) => void,
): { dispose(): void } {
  const element = source.element;
  if (!element) return { dispose: () => {} };

  const onKeyDown = (event: KeyboardEvent): void => {
    const data = resolveTerminalKeyInput(event);
    if (data === null) return;

    event.preventDefault();
    event.stopPropagation();
    write(data);
  };

  element.addEventListener("keydown", onKeyDown, true);
  return {
    dispose: () => element.removeEventListener("keydown", onKeyDown, true),
  };
}

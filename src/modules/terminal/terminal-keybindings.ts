import { isMacPlatform } from "../../shared/keyboard/shortcuts";

export interface TerminalKeybindingSource {
  element?: HTMLElement;
}

export function resolveTerminalKeyInput(event: KeyboardEvent, isMac: boolean): string | null {
  if (event.altKey) return null;

  if (event.shiftKey && event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
    return "\n";
  }

  if (event.shiftKey) return null;

  const cmdHeld = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!cmdHeld) return null;

  if (isMac && event.key === "ArrowLeft") return "\x01";
  if (isMac && event.key === "ArrowRight") return "\x05";
  return null;
}

export function attachTerminalKeybindings(
  source: TerminalKeybindingSource,
  write: (data: string) => void,
): { dispose(): void } {
  const element = source.element;
  if (!element) return { dispose: () => {} };

  const isMac = isMacPlatform();
  const onKeyDown = (event: KeyboardEvent): void => {
    const data = resolveTerminalKeyInput(event, isMac);
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

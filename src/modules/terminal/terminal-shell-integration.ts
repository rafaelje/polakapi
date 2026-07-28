import type { Terminal } from "@xterm/xterm";

/**
 * Custom OSC number the shell-integration scripts (bash/zsh, injected by the
 * Rust side for bare shell spawns — see `src-tauri/src/shell_integration.rs`)
 * use to report each Enter-submitted command: `\x1b]9931;<base64>\x07`. Picked
 * to collide with no known terminal-emulator convention (iTerm 1337, VS Code
 * 633, kitty 22, Konsole 30/31, …) — this is a from-scratch, app-private
 * protocol, not meant to be portable.
 */
const SHELL_COMMAND_OSC = 9931;

function decodeBase64Utf8(b64: string): string | null {
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Registers the OSC handler that captures the last shell command submitted in
 * `term`, calling `onCommand` with the decoded, trimmed text. No-op (handler
 * simply never fires) for panes that never spawn the shell-integration script
 * (AI CLIs, unsupported shells). Malformed payloads are swallowed, not thrown.
 */
export function attachShellCommandCapture(
  term: Terminal,
  onCommand: (command: string) => void,
): { dispose(): void } {
  return term.parser.registerOscHandler(SHELL_COMMAND_OSC, (data) => {
    const decoded = decodeBase64Utf8(data);
    if (decoded !== null && decoded.trim().length > 0) onCommand(decoded);
    return true;
  });
}

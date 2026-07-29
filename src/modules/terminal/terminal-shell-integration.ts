import type { Terminal } from "@xterm/xterm";

// Custom OSC number the shell-integration scripts use to report each
// submitted command: \x1b]9931;<base64>\x07. App-private, not portable.
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

// Registers the OSC handler reporting each submitted command in `term`.
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

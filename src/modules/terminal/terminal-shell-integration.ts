import type { Terminal } from "@xterm/xterm";

// Custom OSC number the shell-integration scripts use to report each
// submitted command: \x1b]9931;<a|c>;<base64>\x07. App-private, not portable.
const SHELL_COMMAND_OSC = 9931;

export interface CapturedShellCommand {
  command: string;
  /** True when the shell resolved the first word to an alias or function. */
  isAlias: boolean;
}

function decodeBase64Utf8(b64: string): string | null {
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}

// Payloads without a flag prefix (older scripts) are treated as non-alias.
export function parseShellCommandPayload(data: string): CapturedShellCommand | null {
  const match = /^([ac]);(.*)$/s.exec(data);
  const isAlias = match?.[1] === "a";
  const decoded = decodeBase64Utf8(match ? match[2] : data);
  if (decoded === null || decoded.trim().length === 0) return null;
  return { command: decoded, isAlias };
}

// Registers the OSC handler reporting each submitted command in `term`.
export function attachShellCommandCapture(
  term: Terminal,
  onCommand: (captured: CapturedShellCommand) => void,
): { dispose(): void } {
  return term.parser.registerOscHandler(SHELL_COMMAND_OSC, (data) => {
    const captured = parseShellCommandPayload(data);
    if (captured !== null) onCommand(captured);
    return true;
  });
}

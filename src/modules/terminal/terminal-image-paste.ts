import { invoke } from "../../shared/tauri/invoke";
import {
  detectShellPlatform,
  formatPathsForShell,
  type TerminalShellPlatform,
} from "./terminal-drop";

const IMAGE_MIME = /^image\//i;
// Paths made only of these characters are written unquoted so CLIs that
// detect bare image paths in pasted text (Claude Code, Codex) keep working.
const BARE_SAFE_PATH = /^[A-Za-z0-9_\-./:\\~]+$/;

/**
 * Returns the image carried by a paste event, or null when the clipboard has
 * text (text paste always wins) or no image at all. Copied screenshots reach
 * the webview as a file item with an `image/*` type and no text payload.
 */
export function extractPastedImage(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  if (readPlainText(dt).trim().length > 0) return null;

  for (const file of Array.from(dt.files ?? [])) {
    if (IMAGE_MIME.test(file.type)) return file;
  }
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file" || !IMAGE_MIME.test(item.type)) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

function readPlainText(dt: DataTransfer): string {
  try {
    return dt.getData("text/plain") || "";
  } catch {
    return "";
  }
}

/** Persists the image via Rust and resolves with its absolute path. */
export async function savePastedImage(image: Blob): Promise<string> {
  const bytes = new Uint8Array(await image.arrayBuffer());
  return invoke<string>("save_pasted_image", bytes, {
    headers: { "x-image-mime": image.type },
    errorMessage: "Failed to save pasted image",
  });
}

export function formatImagePathForShell(
  path: string,
  platform: TerminalShellPlatform = detectShellPlatform(),
): string {
  if (BARE_SAFE_PATH.test(path)) return `${path} `;
  return formatPathsForShell([path], platform);
}

interface ImagePasteTerminal {
  element?: HTMLElement;
  paste(data: string): void;
}

/**
 * xterm only reads `text/plain` from paste events, so Cmd+V / Ctrl+V with an
 * image on the clipboard is silently dropped. Intercept those pastes, save the
 * image to a temp file and paste its path instead.
 */
export function attachTerminalImagePaste(
  term: ImagePasteTerminal,
  save: (image: File) => Promise<string> = savePastedImage,
): { dispose(): void } {
  const element = term.element;
  if (!element) return { dispose: () => {} };

  const onPaste = (event: ClipboardEvent): void => {
    const image = extractPastedImage(event.clipboardData);
    if (!image) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void save(image)
      .then((path) => term.paste(formatImagePathForShell(path)))
      .catch((error) => console.error("Image paste failed", error));
  };

  element.addEventListener("paste", onPaste, true);
  return {
    dispose: () => element.removeEventListener("paste", onPaste, true),
  };
}

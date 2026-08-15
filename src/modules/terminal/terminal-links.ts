import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { invoke } from "../../shared/tauri/invoke";

// Link handling for terminal panes. The webview cannot window.open() (Tauri
// blocks it), so every activation routes through Rust: http(s) URLs to the
// system browser, local paths to the editor / file manager.

export type TerminalLinkTarget = { kind: "url"; url: string } | { kind: "path"; path: string };

/** Punctuation prose wraps around a link but that is not part of it. */
const TRAILING_PUNCT = /[.,;!?)\]}'"”’>]+$/;
const TRAILING_PATH_PUNCT = /[.,;!?}'"”’>]+$/;
/** Trailing `:line` / `:line:col` file references emitted by compilers. */
const LINE_COL_SUFFIX = /(:\d+){1,2}$/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_NETWORK_OR_DEVICE_PATH = /^[\\/]{2}/;

/**
 * Maps raw link text (OSC 8 uri, detected URL, or detected path) to an
 * openable target. Returns null for anything the app should not touch.
 */
export function classifyLinkText(raw: string): TerminalLinkTarget | null {
  const text = raw.trim();
  if (/^https?:\/\//i.test(text)) {
    return { kind: "url", url: text.replace(TRAILING_PUNCT, "") };
  }
  if (/^file:\/\//i.test(text)) {
    const path = pathFromFileUri(text);
    return path === null ? null : { kind: "path", path };
  }
  const path = stripPathDecorations(text);
  if (isOpenablePath(path)) {
    return { kind: "path", path };
  }
  return null;
}

function pathFromFileUri(text: string): string | null {
  try {
    const uri = new URL(text.replace(TRAILING_PUNCT, ""));
    const host = uri.hostname;
    if (host && host.toLowerCase() !== "localhost") return null;
    let path = decodeURIComponent(uri.pathname);
    if (/^\/[A-Za-z]:[\\/]/.test(path)) {
      path = path.slice(1);
    }
    path = stripPathDecorations(path);
    return isOpenablePath(path) ? path : null;
  } catch {
    return null;
  }
}

function stripPathDecorations(path: string): string {
  return path.replace(TRAILING_PATH_PUNCT, "").replace(LINE_COL_SUFFIX, "");
}

function isOpenablePath(path: string): boolean {
  if (WINDOWS_NETWORK_OR_DEVICE_PATH.test(path)) return false;
  return (
    path.startsWith("/") ||
    path === "~" ||
    path.startsWith("~/") ||
    path.startsWith("~\\") ||
    WINDOWS_DRIVE_PATH.test(path)
  );
}

/**
 * xterm's Linkifier activates links on any mouseup without checking the
 * button, and the pane suppresses the native context menu (WebKitGTK paste
 * quirk), so right/middle clicks would open links. Only the primary button
 * may activate.
 */
export function isPrimaryClick(event: MouseEvent): boolean {
  return event.button === 0;
}

export function openLinkTarget(target: TerminalLinkTarget): Promise<void> {
  return target.kind === "url"
    ? invoke<void>("open_url", { url: target.url })
    : invoke<void>("open_local_path", { path: target.path });
}

/** Classify-and-open; silently ignores text that is not an openable link. */
export function openLinkFromText(raw: string): void {
  const target = classifyLinkText(raw);
  if (target) {
    void openLinkTarget(target).catch((error) => {
      console.error("Failed to open terminal link", error);
    });
  }
}

export interface PathMatch {
  /** 0-based offset of the first path character in the line text. */
  start: number;
  text: string;
}

// An absolute (or ~-relative) path: segments of word-ish chars separated by
// "/", optionally ending in ":line[:col]". The leading group keeps URLs out —
// a path match must start the line or follow whitespace/quote/bracket/"=",
// which the "//host/…" part of a URL never does.
const PATH_RE = /(?:^|[\s"'`([<=])((?:~)?\/[\w.@+~-]+(?:\/[\w.@+~-]+)*\/?(?::\d+(?::\d+)?)?)/g;

const QUOTED_WINDOWS_PATH_RE = /(["'])([A-Za-z]:[\\/].*?)\1/g;
const WINDOWS_PATH_RE =
  /(?:^|[\s`([<=])([A-Za-z]:[\\/](?:[^"'`<>\r\n]*?:\d+(?::\d+)?(?=$|[\s,;!?)}\]>])|[^\s"'`<>()[\]{}]+))/g;

// file:// URIs (Claude and other CLIs print these for docs/artifacts they
// create). WebLinksAddon only matches http(s), so these need their own scan.
const FILE_URI_RE = /(?:^|[\s"'`([<])(file:\/\/[^\s"'`)\]>]+)/gi;

/** Finds absolute-path and file:// URI candidates in one rendered terminal line. */
export function findAbsolutePaths(lineText: string): PathMatch[] {
  const out: PathMatch[] = [];
  for (const match of lineText.matchAll(PATH_RE)) {
    const text = match[1].replace(TRAILING_PUNCT, "");
    if (text.length < 2) continue;
    out.push({ start: (match.index ?? 0) + match[0].length - match[1].length, text });
  }
  for (const match of lineText.matchAll(FILE_URI_RE)) {
    const text = match[1].replace(TRAILING_PUNCT, "");
    if (text.length <= "file://".length) continue;
    if (classifyLinkText(text)?.kind !== "path") continue;
    out.push({ start: (match.index ?? 0) + match[0].length - match[1].length, text });
  }
  for (const match of lineText.matchAll(QUOTED_WINDOWS_PATH_RE)) {
    const text = match[2];
    if (!isOpenablePath(stripPathDecorations(text))) continue;
    out.push({ start: (match.index ?? 0) + match[1].length, text });
  }
  for (const match of lineText.matchAll(WINDOWS_PATH_RE)) {
    const text = match[1].replace(TRAILING_PUNCT, "");
    if (!isOpenablePath(stripPathDecorations(text))) continue;
    out.push({ start: (match.index ?? 0) + match[0].length - match[1].length, text });
  }
  return out.sort((left, right) => left.start - right.start);
}

/**
 * xterm link provider that turns absolute paths in output into clickable
 * links (URLs are already covered by WebLinksAddon). Ranges are 1-based and
 * end-inclusive per xterm's IBufferRange contract.
 */
export function createPathLinkProvider(
  term: Terminal,
  activate: (path: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) return callback(undefined);
      const matches = findAbsolutePaths(line.translateToString(true));
      if (matches.length === 0) return callback(undefined);
      callback(
        matches.map((m) => ({
          text: m.text,
          range: {
            start: { x: m.start + 1, y: bufferLineNumber },
            end: { x: m.start + m.text.length, y: bufferLineNumber },
          },
          activate: (event: MouseEvent, text: string): void => {
            if (!isPrimaryClick(event)) return;
            event.preventDefault();
            activate(text);
          },
        })),
      );
    },
  };
}

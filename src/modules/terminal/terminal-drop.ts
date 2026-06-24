import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ptyWrite } from "./pty-client";

const DROP_TARGET_CLASS = "pane-drop-target";

/**
 * Minimal pane lookup contract. The router implements this — we keep it
 * structural so the drop bridge stays unit-testable without spinning up
 * managers.
 */
export interface PaneLookup {
  getActiveHost(): HTMLElement | null;
}

export interface TerminalDropDeps {
  /** Element scoped to the terminal grid for HTML5 (URL / text) drops. */
  gridEl: HTMLElement;
  router: PaneLookup;
}

export interface TerminalDropHandle {
  detach(): void;
}

/**
 * Bridges OS-level Finder drops AND in-browser drag&drop into the terminal
 * pane under the pointer.
 *
 *   - Tauri `onDragDropEvent` delivers absolute file paths from the OS. The
 *     drop is routed to the pane under the cursor; the paths are shell-quoted
 *     and written into the PTY (no Enter is sent — the user reviews first).
 *   - HTML5 `dragover`/`drop` on the grid handles URLs / plain text dropped
 *     from inside the webview or external apps that surface `text/uri-list`.
 *     With `dragDropEnabled: true` the webview blocks HTML5 events for native
 *     OS file drops, but URL drops from browsers still fall through here.
 *
 * Highlight semantics mirror the workspaces panel: the `.pane` under the
 * cursor gets `.pane-drop-target`. Outside the grid the bridge is silent so
 * other surfaces (workspaces, future agent flows) can react on their own.
 */
export function attachTerminalDrop(deps: TerminalDropDeps): TerminalDropHandle {
  const { gridEl, router } = deps;

  let currentTarget: HTMLElement | null = null;
  let unlistenPromise: Promise<UnlistenFn> | null = null;
  let detached = false;

  const setTarget = (next: HTMLElement | null): void => {
    if (currentTarget === next) return;
    if (currentTarget) currentTarget.classList.remove(DROP_TARGET_CLASS);
    currentTarget = next;
    if (currentTarget) currentTarget.classList.add(DROP_TARGET_CLASS);
  };

  const paneAtCssPoint = (x: number, y: number): HTMLElement | null => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const host = router.getActiveHost();
    if (!host || !host.contains(el)) return null;
    return el.closest<HTMLElement>(".pane[data-pty-id]");
  };

  const paneAtPhysicalPoint = (physicalX: number, physicalY: number): HTMLElement | null => {
    // Tauri delivers physical pixels; the DOM uses CSS pixels.
    const ratio = window.devicePixelRatio || 1;
    return paneAtCssPoint(physicalX / ratio, physicalY / ratio);
  };

  const ptyIdOf = (paneEl: HTMLElement | null): string | null => {
    const id = paneEl?.dataset.ptyId;
    return id && id.length > 0 ? id : null;
  };

  const writeToPane = (ptyId: string, text: string): void => {
    if (text.length === 0) return;
    void ptyWrite(ptyId, text).catch((error) => {
      console.error("ptyWrite (drop) failed", error);
    });
  };

  unlistenPromise = getCurrentWebviewWindow().onDragDropEvent((event) => {
    if (detached) return;
    const payload = event.payload;
    switch (payload.type) {
      case "enter":
      case "over": {
        setTarget(paneAtPhysicalPoint(payload.position.x, payload.position.y));
        return;
      }
      case "leave": {
        setTarget(null);
        return;
      }
      case "drop": {
        const pane = paneAtPhysicalPoint(payload.position.x, payload.position.y);
        setTarget(null);
        const ptyId = ptyIdOf(pane);
        if (!ptyId || payload.paths.length === 0) return;
        writeToPane(ptyId, formatPathsForShell(payload.paths));
        return;
      }
    }
  });
  unlistenPromise.catch((error) => {
    console.error("Failed to subscribe to terminal drag-drop events", error);
  });

  // HTML5 dragover/drop for URLs and plain text. Bound on the grid so we only
  // hijack events inside the terminal area — workspace panel drags keep their
  // own handlers.
  const onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer) return;
    if (!hasTextLike(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const target = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>(
      ".pane[data-pty-id]",
    );
    setTarget(target ?? null);
  };
  const onDragLeave = (e: DragEvent): void => {
    // Only clear when the pointer leaves the grid entirely — without this the
    // class flickers as the drag crosses child boundaries.
    if (e.relatedTarget instanceof Node && gridEl.contains(e.relatedTarget)) return;
    setTarget(null);
  };
  const onDrop = (e: DragEvent): void => {
    if (!e.dataTransfer) return;
    const text = readDroppedText(e.dataTransfer);
    if (!text) return;
    const target = (e.target instanceof Element ? e.target : null)?.closest<HTMLElement>(
      ".pane[data-pty-id]",
    );
    setTarget(null);
    const ptyId = ptyIdOf(target ?? null);
    if (!ptyId) return;
    e.preventDefault();
    writeToPane(ptyId, text);
  };

  gridEl.addEventListener("dragover", onDragOver);
  gridEl.addEventListener("dragleave", onDragLeave);
  gridEl.addEventListener("drop", onDrop);

  return {
    detach(): void {
      detached = true;
      setTarget(null);
      gridEl.removeEventListener("dragover", onDragOver);
      gridEl.removeEventListener("dragleave", onDragLeave);
      gridEl.removeEventListener("drop", onDrop);
      const pending = unlistenPromise;
      unlistenPromise = null;
      if (!pending) return;
      void pending
        .then((off) => off())
        .catch((error) => {
          console.error("Failed to detach terminal drag-drop listener", error);
        });
    },
  };
}

/**
 * Builds the text inserted into the PTY for a file drop. Each path is
 * single-quoted so spaces / globs survive the shell; multiple paths are
 * space-separated. A trailing space is appended so the user can keep typing
 * arguments. No newline — they review the line first and press Enter
 * themselves.
 */
export function formatPathsForShell(paths: readonly string[]): string {
  const quoted = paths.map(shellQuote).filter((s) => s.length > 0);
  if (quoted.length === 0) return "";
  return `${quoted.join(" ")} `;
}

function shellQuote(path: string): string {
  if (path.length === 0) return "";
  // POSIX-safe single quoting: wrap in '...' and escape embedded ' as '\''.
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function hasTextLike(dt: DataTransfer): boolean {
  // Empty when the drag is purely file-typed and `dragDropEnabled: true`
  // already steered it to the native handler.
  const types = dt.types;
  for (const t of types) {
    if (t === "text/uri-list" || t === "text/plain" || t === "text") return true;
  }
  return false;
}

function readDroppedText(dt: DataTransfer): string {
  const uriList = dt.getData("text/uri-list");
  if (uriList) {
    const urls = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    if (urls.length > 0) return `${urls.join(" ")} `;
  }
  const plain = dt.getData("text/plain") || dt.getData("text");
  if (plain) return plain;
  return "";
}

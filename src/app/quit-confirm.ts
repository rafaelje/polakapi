import { getCurrentWindow } from "@tauri-apps/api/window";

import { confirmModal } from "../modules/workspaces/confirm-delete";
import type { WorkspacesState } from "../modules/workspaces/types";
import { findProject } from "../modules/workspaces/workspaces-reducer";
import type { TerminalRouter } from "./terminal-router";

export interface QuitConfirmOptions {
  router: TerminalRouter;
  /** Resolves the live workspaces snapshot for the project-name lookup. */
  getState: () => WorkspacesState;
}

/**
 * Wires the Tauri window's `onCloseRequested` (with a `beforeunload` fallback
 * for the plain browser) so a quit attempt while any PTY is still alive shows
 * a confirmation modal before the process tears down. Returns an `unwire` fn
 * that removes both hooks.
 *
 * Concurrency contract:
 *   - `preventDefault()` is called synchronously inside the close handler so
 *     Tauri does not proceed with the close while the modal is open.
 *   - A `closing` flag dedupes the Tauri handler vs `beforeunload`, which
 *     still fires after a Tauri `destroy()`.
 */
export function wireQuitConfirm(opts: QuitConfirmOptions): () => void {
  const { router, getState } = opts;
  let closing = false;
  let unlistenClose: (() => void) | null = null;

  const formatMessage = (): string => {
    const counts = router.liveCountsByProject();
    const state = getState();
    const lines: string[] = [];
    for (const [projectId, count] of counts) {
      if (count <= 0) continue;
      const project = findProject(state, projectId)?.project;
      const name = project?.name ?? "(unknown project)";
      lines.push(`• ${name}: ${count} terminal${count === 1 ? "" : "s"}`);
    }
    const total = router.totalLiveCount();
    const header = `${total} terminal${total === 1 ? "" : "s"} still running:`;
    return lines.length > 0 ? `${header}\n${lines.join("\n")}` : header;
  };

  const askToQuit = async (): Promise<boolean> => {
    if (router.totalLiveCount() === 0) return true;
    return confirmModal({
      title: "Quit polakapi?",
      message: formatMessage(),
      confirmLabel: "Quit anyway",
      cancelLabel: "Stay",
      danger: true,
    });
  };

  void getCurrentWindow()
    .onCloseRequested(async (event) => {
      if (closing) return;
      // Synchronous prevent so Tauri does not race the modal.
      event.preventDefault();
      const ok = await askToQuit();
      if (!ok) return;
      closing = true;
      try {
        await router.disposeAll();
      } catch (error) {
        console.error("Failed to dispose terminals before quit", error);
      }
      await getCurrentWindow().destroy();
    })
    .then((un) => {
      unlistenClose = un;
    })
    .catch((error) => {
      // Non-Tauri runtime (e.g. vitest jsdom) — the beforeunload fallback
      // below still works.
      console.warn("onCloseRequested unavailable", error);
    });

  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (closing) return;
    if (router.totalLiveCount() === 0) return;
    // The browser-spec `beforeunload` cannot run an async modal, so the best
    // we can do is signal "are you sure?". The Tauri handler above is the
    // real UX surface; this is just a safety net.
    event.preventDefault();
    event.returnValue = "";
  };

  window.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    window.removeEventListener("beforeunload", onBeforeUnload);
    unlistenClose?.();
    unlistenClose = null;
  };
}

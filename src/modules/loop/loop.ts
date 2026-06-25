// Entry script for the /loop window. Bootstraps the gate router + chrome.
//
// Flow:
//   1. Create a `LoopRouter` (lives only in this window; the workspaces
//      state lives in the main window — we read its snapshot from disk).
//   2. Mount the chrome (header + 3-step slot) into `#loop-root`.
//   3. Trigger the first `refresh()` and re-refresh on window focus so the
//      gate picks up changes the user made in the main window between focuses.

import { getCurrentWindow } from "@tauri-apps/api/window";

import { mountLoopChrome } from "./loop-chrome";
import { LoopRouter } from "./state/run-context";

async function main(): Promise<void> {
  const root = document.getElementById("loop-root");
  if (!root) {
    console.error("loop.ts: #loop-root missing from loop.html");
    return;
  }

  const router = new LoopRouter();
  mountLoopChrome(root, router);

  // Initial load — paints the gate as soon as it resolves. Any IO error
  // keeps it in "loading" state because the router only switches on success;
  // in that case we log to console for debugging.
  try {
    await router.refresh();
  } catch (err) {
    console.error("loop.ts: initial refresh failed", err);
  }

  // Refresh-on-focus: the main window can change the activeProject while
  // /loop is open. When focus returns to this window, we re-read the store
  // snapshot and reconcile the gate.
  const win = getCurrentWindow();
  void win.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      void router.refresh().catch((err) => {
        console.error("loop.ts: focus refresh failed", err);
      });
    }
  });
}

void main();

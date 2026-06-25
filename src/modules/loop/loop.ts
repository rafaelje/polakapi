import { getCurrentWindow } from "@tauri-apps/api/window";

import { mountLoopChrome } from "./loop-chrome";
import { LoopRouter } from "./core/run-context";

async function main(): Promise<void> {
  const root = document.getElementById("loop-root");
  if (!root) {
    console.error("loop.ts: #loop-root missing from loop.html");
    return;
  }

  const router = new LoopRouter();
  mountLoopChrome(root, router);

  try {
    await router.refresh();
  } catch (err) {
    console.error("loop.ts: initial refresh failed", err);
  }

  // Refresh on focus: the main window can change activeProject while /loop is open.
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

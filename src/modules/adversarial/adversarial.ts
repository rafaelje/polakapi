import { getCurrentWindow } from "@tauri-apps/api/window";

import { mountAdversarialChrome } from "./adversarial-chrome";
import { AdvRouter } from "./run-context";

async function main(): Promise<void> {
  const root = document.getElementById("adv-root");
  if (!root) {
    console.error("adversarial.ts: #adv-root missing from adversarial.html");
    return;
  }

  const router = new AdvRouter();
  mountAdversarialChrome(root, router);

  try {
    await router.refresh();
  } catch (err) {
    console.error("adversarial.ts: initial refresh failed", err);
  }

  const win = getCurrentWindow();
  void win.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      void router.refresh().catch((err) => {
        console.error("adversarial.ts: focus refresh failed", err);
      });
    }
  });
}

void main();

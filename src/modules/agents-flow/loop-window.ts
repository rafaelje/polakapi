import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { showToast } from "../../shared/ui/toast";

// One window per app (label "loop"): a second click focuses the existing
// instance instead of erroring on the duplicate-label create call. Window
// flags (decorations, parent, etc.) are fixed at creation, so changing them
// requires closing the live window first.

const LOOP_LABEL = "loop";
const LOOP_BUTTON_ID = "open-loop";

async function findExisting(): Promise<WebviewWindow | null> {
  const all = await getAllWebviewWindows();
  return all.find((win) => win.label === LOOP_LABEL) ?? null;
}

export async function openLoopWindow(): Promise<void> {
  try {
    const existing = await findExisting();
    if (existing) {
      await existing.unminimize();
      await existing.show();
      await existing.setFocus();
      return;
    }
    const popup = new WebviewWindow(LOOP_LABEL, {
      url: "loop.html",
      title: "/loop",
      width: 640,
      height: 480,
      minWidth: 320,
      minHeight: 240,
      // Native chrome: titlebar, traffic lights / min-max-close, dock entry.
      decorations: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      closable: true,
      focus: true,
    });
    void popup.once("tauri://error", (event) => {
      console.error("Failed to create /loop window", event.payload);
      showToast("Could not open /loop window", "error");
    });
  } catch (error) {
    console.error("openLoopWindow threw", error);
    showToast("Could not open /loop window", "error");
  }
}

export interface LoopButtonHandle {
  dispose(): void;
}

export function mountLoopButton(): LoopButtonHandle {
  const btn = document.getElementById(LOOP_BUTTON_ID);
  if (!(btn instanceof HTMLButtonElement)) {
    return { dispose: () => {} };
  }
  const onClick = (): void => {
    void openLoopWindow();
  };
  btn.addEventListener("click", onClick);
  return {
    dispose: () => btn.removeEventListener("click", onClick),
  };
}

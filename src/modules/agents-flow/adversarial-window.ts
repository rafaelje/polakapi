import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { showToast } from "../../shared/ui/toast";

// One window per app (label "adversarial-review"): a second click focuses the
// existing instance. Mirrors the loop/prompts window pattern so the three
// popups behave the same.

const ADV_LABEL = "adversarial-review";
const ADV_BUTTON_ID = "open-adversarial-review";

async function findExisting(): Promise<WebviewWindow | null> {
  const all = await getAllWebviewWindows();
  return all.find((win) => win.label === ADV_LABEL) ?? null;
}

export async function openAdversarialWindow(): Promise<void> {
  try {
    const existing = await findExisting();
    if (existing) {
      await existing.unminimize();
      await existing.show();
      await existing.setFocus();
      return;
    }
    const popup = new WebviewWindow(ADV_LABEL, {
      url: "adversarial.html",
      title: "/adversarial review",
      width: 820,
      height: 620,
      minWidth: 480,
      minHeight: 360,
      decorations: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      closable: true,
      focus: true,
    });
    void popup.once("tauri://error", (event) => {
      console.error("Failed to create /adversarial review window", event.payload);
      showToast("Could not open /adversarial review window", "error");
    });
  } catch (error) {
    console.error("openAdversarialWindow threw", error);
    showToast("Could not open /adversarial review window", "error");
  }
}

export interface AdversarialButtonHandle {
  dispose(): void;
}

export function mountAdversarialButton(): AdversarialButtonHandle {
  const btn = document.getElementById(ADV_BUTTON_ID);
  if (!(btn instanceof HTMLButtonElement)) {
    return { dispose: () => {} };
  }
  const onClick = (): void => {
    void openAdversarialWindow();
  };
  btn.addEventListener("click", onClick);
  return {
    dispose: () => btn.removeEventListener("click", onClick),
  };
}

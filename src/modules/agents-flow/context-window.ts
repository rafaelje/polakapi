import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { showToast } from "../../shared/ui/toast";

const CONTEXT_LABEL = "context";
const CONTEXT_BUTTON_ID = "open-context";

async function findExisting(): Promise<WebviewWindow | null> {
  const all = await getAllWebviewWindows();
  return all.find((win) => win.label === CONTEXT_LABEL) ?? null;
}

export async function openContextWindow(): Promise<void> {
  try {
    const existing = await findExisting();
    if (existing) {
      await existing.unminimize();
      await existing.show();
      await existing.setFocus();
      return;
    }
    const popup = new WebviewWindow(CONTEXT_LABEL, {
      url: "context.html",
      title: "/context",
      width: 1120,
      height: 720,
      minWidth: 780,
      minHeight: 460,
      decorations: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      closable: true,
      focus: true,
    });
    void popup.once("tauri://error", (event) => {
      console.error("Failed to create /context window", event.payload);
      showToast("Could not open /context window", "error");
    });
  } catch (error) {
    console.error("openContextWindow threw", error);
    showToast("Could not open /context window", "error");
  }
}

export interface ContextButtonHandle {
  dispose(): void;
}

export function mountContextButton(): ContextButtonHandle {
  const button = document.getElementById(CONTEXT_BUTTON_ID);
  if (!(button instanceof HTMLButtonElement)) {
    return { dispose: () => {} };
  }
  const onClick = (): void => {
    void openContextWindow();
  };
  button.addEventListener("click", onClick);
  return {
    dispose: () => button.removeEventListener("click", onClick),
  };
}

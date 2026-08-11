import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { showToast } from "../../shared/ui/toast";

const SESSIONS_LABEL = "sessions";
const SESSIONS_BUTTON_ID = "open-sessions";

async function findExisting(): Promise<WebviewWindow | null> {
  const all = await getAllWebviewWindows();
  return all.find((win) => win.label === SESSIONS_LABEL) ?? null;
}

export async function openSessionsWindow(): Promise<void> {
  try {
    const existing = await findExisting();
    if (existing) {
      await existing.unminimize();
      await existing.show();
      await existing.setFocus();
      return;
    }
    const popup = new WebviewWindow(SESSIONS_LABEL, {
      url: "sessions.html",
      title: "/sessions",
      width: 1080,
      height: 680,
      minWidth: 760,
      minHeight: 420,
      decorations: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      closable: true,
      focus: true,
    });
    void popup.once("tauri://error", (event) => {
      console.error("Failed to create /sessions window", event.payload);
      showToast("Could not open /sessions window", "error");
    });
  } catch (error) {
    console.error("openSessionsWindow threw", error);
    showToast("Could not open /sessions window", "error");
  }
}

export interface SessionsButtonHandle {
  dispose(): void;
}

export function mountSessionsButton(): SessionsButtonHandle {
  const button = document.getElementById(SESSIONS_BUTTON_ID);
  if (!(button instanceof HTMLButtonElement)) {
    return { dispose: () => {} };
  }
  const onClick = (): void => {
    void openSessionsWindow();
  };
  button.addEventListener("click", onClick);
  return {
    dispose: () => button.removeEventListener("click", onClick),
  };
}

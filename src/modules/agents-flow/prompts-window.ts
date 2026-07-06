import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { showToast } from "../../shared/ui/toast";

// One window per app (label "prompts"): a second click focuses the existing
// instance. Mirrors the loop-window pattern so the two popups behave the
// same.

const PROMPTS_LABEL = "prompts";
const PROMPTS_BUTTON_ID = "open-prompts";

async function findExisting(): Promise<WebviewWindow | null> {
  const all = await getAllWebviewWindows();
  return all.find((win) => win.label === PROMPTS_LABEL) ?? null;
}

export async function openPromptsWindow(): Promise<void> {
  try {
    const existing = await findExisting();
    if (existing) {
      await existing.unminimize();
      await existing.show();
      await existing.setFocus();
      return;
    }
    const popup = new WebviewWindow(PROMPTS_LABEL, {
      url: "prompts.html",
      title: "/prompts",
      width: 900,
      height: 600,
      minWidth: 480,
      minHeight: 320,
      decorations: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      closable: true,
      focus: true,
    });
    void popup.once("tauri://error", (event) => {
      console.error("Failed to create /prompts window", event.payload);
      showToast("Could not open /prompts window", "error");
    });
  } catch (error) {
    console.error("openPromptsWindow threw", error);
    showToast("Could not open /prompts window", "error");
  }
}

export interface PromptsButtonHandle {
  dispose(): void;
}

export function mountPromptsButton(): PromptsButtonHandle {
  const btn = document.getElementById(PROMPTS_BUTTON_ID);
  if (!(btn instanceof HTMLButtonElement)) {
    return { dispose: () => {} };
  }
  const onClick = (): void => {
    void openPromptsWindow();
  };
  btn.addEventListener("click", onClick);
  return {
    dispose: () => btn.removeEventListener("click", onClick),
  };
}

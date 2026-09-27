import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { showToast } from "../../shared/ui/toast";
import { buildCodeReviewUrl, codeReviewWindowLabel } from "../code-review/code-review-model";
import type { PinnedProject } from "../code-review/types";

const CODE_REVIEW_BUTTON_ID = "open-code-review";

async function findExisting(label: string): Promise<WebviewWindow | null> {
  const all = await getAllWebviewWindows();
  return all.find((win) => win.label === label) ?? null;
}

export async function openCodeReviewWindow(project: PinnedProject): Promise<void> {
  try {
    const label = codeReviewWindowLabel(project.path);
    const existing = await findExisting(label);
    if (existing) {
      await existing.unminimize();
      await existing.show();
      await existing.setFocus();
      return;
    }
    const popup = new WebviewWindow(label, {
      url: buildCodeReviewUrl(project),
      title: `/code-review · ${project.name}`,
      width: 1440,
      height: 880,
      minWidth: 900,
      minHeight: 480,
      decorations: true,
      resizable: true,
      maximizable: true,
      minimizable: true,
      closable: true,
      focus: true,
    });
    void popup.once("tauri://error", (event) => {
      console.error("Failed to create /code-review window", event.payload);
      showToast("Could not open /code-review window", "error");
    });
  } catch (error) {
    console.error("openCodeReviewWindow threw", error);
    showToast("Could not open /code-review window", "error");
  }
}

export interface CodeReviewButtonDeps {
  getActiveProject(): PinnedProject | null;
}

export interface CodeReviewButtonHandle {
  dispose(): void;
}

export function mountCodeReviewButton(deps: CodeReviewButtonDeps): CodeReviewButtonHandle {
  const button = document.getElementById(CODE_REVIEW_BUTTON_ID);
  if (!(button instanceof HTMLButtonElement)) {
    return { dispose: () => {} };
  }
  const onClick = (): void => {
    const project = deps.getActiveProject();
    if (!project) {
      showToast("Open a project to review its changes", "error");
      return;
    }
    void openCodeReviewWindow(project);
  };
  button.addEventListener("click", onClick);
  return {
    dispose: () => button.removeEventListener("click", onClick),
  };
}

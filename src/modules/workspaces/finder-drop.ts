import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { formatPathError } from "./path-validation";
import type { PathValidation, WorkspaceId } from "./types";
import type { WorkspacesController } from "./workspaces-controller";

/**
 * Dependencies for the Finder drag-and-drop bridge. `validatePath` is injected
 * (rather than imported) so the panel can swap it in tests, and `toast` is
 * routed through the host so the finder-drop module stays UI-agnostic.
 */
export interface FinderDropDeps {
  controller: WorkspacesController;
  validatePath: (path: string) => Promise<PathValidation>;
  toast: (msg: string, kind?: "info" | "error") => void;
}

export interface FinderDropHandle {
  detach(): void;
}

const DROP_TARGET_CLASS = "ws-drop-target";

/**
 * Subscribes to Tauri 2's native drag-drop event on the current webview window
 * and routes OS-level folder drops into `controller.addProject` for the
 * workspace the cursor is hovering. Highlight semantics mirror the in-app
 * HTML5 dnd: `.ws-drop-target` on the workspace under the pointer.
 *
 * Resolution flow per event:
 *   - 'enter' / 'over': compute the workspace under the cursor via
 *     `document.elementFromPoint` (after PhysicalPosition → CSS px conversion)
 *     and apply `.ws-drop-target` to it. Clear it from any sibling.
 *   - 'drop': resolve the target the same way; if non-null, validate every
 *     path and add the valid ones. Invalid paths surface a per-path toast.
 *   - 'leave': clear the highlight.
 */
export function attachFinderDrop(panelRoot: HTMLElement, deps: FinderDropDeps): FinderDropHandle {
  const { controller, validatePath, toast } = deps;

  let currentTarget: HTMLElement | null = null;
  let unlistenPromise: Promise<UnlistenFn> | null = null;
  let detached = false;

  const setTarget = (next: HTMLElement | null): void => {
    if (currentTarget === next) return;
    if (currentTarget) currentTarget.classList.remove(DROP_TARGET_CLASS);
    currentTarget = next;
    if (currentTarget) currentTarget.classList.add(DROP_TARGET_CLASS);
  };

  interface DropResolution {
    insidePanel: boolean;
    workspaceEl: HTMLElement | null;
  }

  const resolveAt = (physicalX: number, physicalY: number): DropResolution => {
    // Tauri delivers physical pixels; the DOM uses CSS pixels.
    const ratio = window.devicePixelRatio || 1;
    const x = physicalX / ratio;
    const y = physicalY / ratio;
    const el = document.elementFromPoint(x, y);
    if (!el || !panelRoot.contains(el)) {
      return { insidePanel: false, workspaceEl: null };
    }
    return { insidePanel: true, workspaceEl: el.closest<HTMLElement>(".ws-workspace") };
  };

  const workspaceIdOf = (el: HTMLElement | null): WorkspaceId | null => {
    const id = el?.dataset.workspaceId;
    return id ? (id as WorkspaceId) : null;
  };

  const handleDrop = async (
    paths: readonly string[],
    resolution: DropResolution,
  ): Promise<void> => {
    // Drop landed outside the workspaces panel — let other surfaces (terminal
    // grid, agent flows, ...) react via their own onDragDropEvent listeners.
    if (!resolution.insidePanel) return;
    const workspaceId = workspaceIdOf(resolution.workspaceEl);
    if (!workspaceId) {
      toast("Drop on a workspace", "info");
      return;
    }
    let added = 0;
    for (const path of paths) {
      const validation = await validatePath(path);
      if (!validation.ok) {
        toast(`${basename(path)}: ${formatPathError(validation)}`, "error");
        continue;
      }
      controller.addProject(workspaceId, { name: basename(path), path });
      added += 1;
    }
    if (added > 1) {
      toast(`${added} projects added`, "info");
    } else if (added === 1) {
      toast("Project added", "info");
    }
  };

  unlistenPromise = getCurrentWebviewWindow().onDragDropEvent((event) => {
    if (detached) return;
    const payload = event.payload;
    switch (payload.type) {
      case "enter":
      case "over": {
        const { workspaceEl } = resolveAt(payload.position.x, payload.position.y);
        setTarget(workspaceEl);
        return;
      }
      case "leave": {
        setTarget(null);
        return;
      }
      case "drop": {
        const resolution = resolveAt(payload.position.x, payload.position.y);
        setTarget(null);
        void handleDrop(payload.paths, resolution);
        return;
      }
    }
  });

  unlistenPromise.catch((error) => {
    console.error("Failed to subscribe to drag-drop events", error);
  });

  return {
    detach(): void {
      detached = true;
      setTarget(null);
      const pending = unlistenPromise;
      unlistenPromise = null;
      if (!pending) return;
      void pending
        .then((off) => off())
        .catch((error) => {
          console.error("Failed to detach drag-drop listener", error);
        });
    },
  };
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "Project";
}

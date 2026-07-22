import type { WorkspacesController } from "./state/workspaces-controller";
import { findShortcutTarget } from "./state/workspaces-reducer-shortcuts";

export function wireActivationShortcuts(controller: WorkspacesController): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (!e.ctrlKey || !e.altKey || e.metaKey || e.shiftKey) return;
    const key = e.key.toLowerCase();
    if (!/^[a-z0-9]$/.test(key)) return;
    const target = findShortcutTarget(controller.getState(), key);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    if (target.kind === "project") {
      controller.setActiveProject(target.projectId);
      return;
    }
    const workspace = controller.getState().workspaces.find((w) => w.id === target.workspaceId);
    if (!workspace) return;
    if (workspace.collapsed) controller.toggleCollapsed(workspace.id);
    const first = workspace.projects[0];
    if (first) controller.setActiveProject(first.id);
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}

import {
  computeInsertionIndex,
  createVisuals,
  currentOrder,
  type VisualsHandle,
} from "./drag-drop-visuals";
import type { ProjectId, WorkspaceId } from "./types";
import type { WorkspacesController } from "./workspaces-controller";

export interface DragDropDeps {
  controller: WorkspacesController;
}

export interface DragDropHandle {
  detach(): void;
}

type DragKind = "project" | "workspace";

interface ActiveDrag {
  kind: DragKind;
  id: string;
  fromWorkspace: WorkspaceId | null;
}

const MIME_PROJECT = "application/x-polakapi-project";
const MIME_WORKSPACE = "application/x-polakapi-workspace";

/**
 * HTML5 drag-and-drop wiring for the workspaces panel. Supports:
 *   1. Reorder projects inside the same workspace.
 *   2. Move a project across workspaces.
 *   3. Reorder workspaces themselves.
 *
 * Visual feedback uses `.ws-drop-target` on the hovered workspace container
 * and `.ws-insertion-line` as a between-row indicator (see drag-drop-visuals).
 * All listeners are attached to `panelRoot` and removed in `detach()`.
 */
export function attach(panelRoot: HTMLElement, deps: DragDropDeps): DragDropHandle {
  const { controller } = deps;
  const visuals: VisualsHandle = createVisuals();
  let active: ActiveDrag | null = null;

  const onDragStart = (e: DragEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target || !e.dataTransfer) return;

    const projectRow = target.closest<HTMLElement>(".ws-project-row");
    if (projectRow) {
      const id = projectRow.dataset.projectId;
      const from = projectRow.dataset.workspaceId;
      if (!id || !from) return;
      active = { kind: "project", id, fromWorkspace: from as WorkspaceId };
      e.dataTransfer.setData(MIME_PROJECT, id);
      e.dataTransfer.effectAllowed = "move";
      projectRow.classList.add("dragging");
      return;
    }

    const wsHeader = target.closest<HTMLElement>(".ws-workspace-header");
    if (wsHeader && !target.closest("button")) {
      const wrapper = wsHeader.closest<HTMLElement>(".ws-workspace");
      const id = wrapper?.dataset.workspaceId;
      if (!wrapper || !id) return;
      active = { kind: "workspace", id, fromWorkspace: null };
      e.dataTransfer.setData(MIME_WORKSPACE, id);
      e.dataTransfer.effectAllowed = "move";
      wrapper.classList.add("dragging");
    }
  };

  const onDragEnd = (): void => {
    panelRoot.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
    visuals.clear();
    active = null;
  };

  const onDragOver = (e: DragEvent): void => {
    if (!active) return;
    const targetEl = e.target as HTMLElement | null;
    if (!targetEl) return;

    if (active.kind === "project") {
      const list = targetEl.closest<HTMLElement>(".ws-projects");
      const wsWrap = targetEl.closest<HTMLElement>(".ws-workspace");
      if (!list || !wsWrap) {
        visuals.clear();
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      visuals.setDropTarget(wsWrap);
      visuals.showInsertionLine(list, e.clientY, ".ws-project-row", active.id);
      return;
    }

    const body = targetEl.closest<HTMLElement>(".ws-panel-body");
    if (!body) {
      visuals.clear();
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    visuals.setDropTarget(null);
    visuals.showInsertionLine(body, e.clientY, ".ws-workspace", active.id);
  };

  const onDrop = (e: DragEvent): void => {
    if (!active) return;
    const targetEl = e.target as HTMLElement | null;
    if (!targetEl) return;

    if (active.kind === "project") {
      const list = targetEl.closest<HTMLElement>(".ws-projects");
      if (!list) return;
      e.preventDefault();
      const toWorkspace = list.dataset.workspaceId as WorkspaceId | undefined;
      if (!toWorkspace) return;
      const projectId = active.id as ProjectId;
      const index = computeInsertionIndex(list, e.clientY, ".ws-project-row", projectId);
      if (toWorkspace === active.fromWorkspace) {
        const ids = currentOrder<ProjectId>(list, ".ws-project-row");
        ids.splice(ids.indexOf(projectId), 1);
        ids.splice(index, 0, projectId);
        controller.reorderProjects(toWorkspace, ids);
      } else {
        controller.moveProject(projectId, toWorkspace, index);
      }
    } else {
      const body = targetEl.closest<HTMLElement>(".ws-panel-body");
      if (!body) return;
      e.preventDefault();
      const wsId = active.id as WorkspaceId;
      const ids = currentOrder<WorkspaceId>(body, ".ws-workspace");
      const index = computeInsertionIndex(body, e.clientY, ".ws-workspace", wsId);
      ids.splice(ids.indexOf(wsId), 1);
      ids.splice(index, 0, wsId);
      controller.reorderWorkspaces(ids);
    }
    visuals.clear();
  };

  const onDragLeave = (e: DragEvent): void => {
    if (!panelRoot.contains(e.relatedTarget as Node | null)) visuals.clear();
  };

  panelRoot.addEventListener("dragstart", onDragStart);
  panelRoot.addEventListener("dragend", onDragEnd);
  panelRoot.addEventListener("dragover", onDragOver);
  panelRoot.addEventListener("drop", onDrop);
  panelRoot.addEventListener("dragleave", onDragLeave);

  return {
    detach(): void {
      panelRoot.removeEventListener("dragstart", onDragStart);
      panelRoot.removeEventListener("dragend", onDragEnd);
      panelRoot.removeEventListener("dragover", onDragOver);
      panelRoot.removeEventListener("drop", onDrop);
      panelRoot.removeEventListener("dragleave", onDragLeave);
      visuals.clear();
      panelRoot.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
    },
  };
}

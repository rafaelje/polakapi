import {
  computeInsertionIndex,
  createVisuals,
  currentOrder,
  type VisualsHandle,
} from "./drag-drop-visuals";
import type { SelectionStore } from "../state/selection";
import type { ProjectId, WorkspaceId } from "../state/types";
import type { WorkspacesController } from "../state/workspaces-controller";

// Pointer-event drag-drop for the workspaces panel.
//
// Why not HTML5 DnD? Tauri 2 on macOS sets `dragDropEnabled: true` on the
// main window so the OS can route Finder file drops into the app. With that
// flag on, WKWebView intercepts drag events at the native layer and the
// webview never receives `dragover` for internal HTML5 drags — `dragstart`
// fires followed immediately by `dragend`, killing any interactive drag UX.
//
// This module uses pointerdown/pointermove/pointerup with `setPointerCapture`
// so the cursor is tracked manually. A small ghost element follows the
// pointer; `document.elementFromPoint` resolves the hovered drop zone. The
// visuals helpers and the rest of the drop semantics (insertion index,
// reorderProjects / moveProjects / reorderWorkspaces) are unchanged.
//
// Click suppression: when a drag actually commits (pointer moves past the
// threshold), a one-shot capture-phase `click` listener swallows the click
// the browser would otherwise emit on pointerup, so the row's normal click
// handler (which activates the project) does not also fire.

export interface DragDropDeps {
  controller: WorkspacesController;
  selection: SelectionStore;
}

export interface DragDropHandle {
  detach(): void;
}

// Minimum pointer travel before a press becomes a drag. Below this, the
// press is treated as a click and the row's click handler runs normally.
const DRAG_THRESHOLD_PX = 5;

interface SessionBase {
  sourceEl: HTMLElement;
  startX: number;
  startY: number;
  pointerId: number;
  committed: boolean;
  idSet: ReadonlySet<string>;
  ghost: HTMLElement | null;
}

type Session =
  | (SessionBase & {
      kind: "project";
      sourceId: ProjectId;
      fromWorkspace: WorkspaceId;
      ids: ProjectId[];
    })
  | (SessionBase & {
      kind: "workspace";
      sourceId: WorkspaceId;
      ids: WorkspaceId[];
    });

export function attach(panelRoot: HTMLElement, deps: DragDropDeps): DragDropHandle {
  const { controller, selection } = deps;
  const visuals: VisualsHandle = createVisuals();
  let session: Session | null = null;

  const resolveProjectDropZone = (
    el: HTMLElement,
  ): { wsWrap: HTMLElement; list: HTMLElement } | null => {
    const wsWrap = el.closest<HTMLElement>(".ws-workspace");
    if (!wsWrap) return null;
    const list =
      el.closest<HTMLElement>(".ws-projects") ?? wsWrap.querySelector<HTMLElement>(".ws-projects");
    if (!list) return null;
    return { wsWrap, list };
  };

  const moveGhost = (ghost: HTMLElement, clientX: number, clientY: number): void => {
    ghost.style.transform = `translate(${clientX + 10}px, ${clientY + 10}px)`;
  };

  const buildGhost = (text: string): HTMLElement => {
    const ghost = document.createElement("div");
    ghost.className = "ws-drag-ghost";
    ghost.textContent = text;
    moveGhost(ghost, -9999, -9999);
    document.body.append(ghost);
    return ghost;
  };

  const cleanupSession = (s: Session): void => {
    s.ghost?.remove();
    panelRoot.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
    visuals.clear();
  };

  // Capture-phase click suppressor armed only when a real drag completed.
  // The browser emits a synthesized `click` after pointerup; without this,
  // dropping back over (or near) the source row would activate the project.
  const suppressNextClick = (): void => {
    const handler = (ev: MouseEvent): void => {
      ev.stopImmediatePropagation();
      ev.preventDefault();
    };
    document.addEventListener("click", handler, { capture: true, once: true });
    // Safety: if no click fires (browser quirks), remove the handler shortly.
    setTimeout(() => document.removeEventListener("click", handler, { capture: true }), 250);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // Buttons (kebab, add, chevron) and inputs handle their own click flow.
    if (target.closest("button, input, textarea")) return;
    // Modifier-clicks belong to multi-select, not to drag. The row's click
    // handler reads modifiers; we stay out of the way.
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;

    const projectRow = target.closest<HTMLElement>(".ws-project-row");
    if (projectRow) {
      const id = projectRow.dataset.projectId as ProjectId | undefined;
      const from = projectRow.dataset.workspaceId as WorkspaceId | undefined;
      if (!id || !from) return;
      session = {
        kind: "project",
        sourceEl: projectRow,
        sourceId: id,
        fromWorkspace: from,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        committed: false,
        ids: [],
        idSet: new Set(),
        ghost: null,
      };
      return;
    }

    const wsHeader = target.closest<HTMLElement>(".ws-workspace-header");
    if (wsHeader) {
      const wrapper = wsHeader.closest<HTMLElement>(".ws-workspace");
      const id = wrapper?.dataset.workspaceId as WorkspaceId | undefined;
      if (!wrapper || !id) return;
      session = {
        kind: "workspace",
        sourceEl: wrapper,
        sourceId: id,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        committed: false,
        ids: [id],
        idSet: new Set([id]),
        ghost: null,
      };
    }
  };

  const commitSession = (s: Session): void => {
    s.committed = true;
    if (s.kind === "project") {
      // Decide the moving group lazily, at the moment the press becomes a
      // drag — using the selection state captured right now (not at
      // pointerdown), so the user can shift-click to extend the selection
      // and then drag immediately. In practice clicks fire before drags so
      // this distinction rarely matters, but it keeps the rule consistent.
      const selected = selection.getSelected();
      const ids: ProjectId[] = selected.has(s.sourceId)
        ? orderedSelectedInPanel(panelRoot, selected)
        : [s.sourceId];
      s.ids = ids;
      s.idSet = new Set(ids);
      for (const pid of ids) {
        panelRoot
          .querySelector<HTMLElement>(`.ws-project-row[data-project-id="${pid}"]`)
          ?.classList.add("dragging");
      }
      const label =
        ids.length > 1
          ? `${ids.length} projects`
          : (s.sourceEl.querySelector<HTMLElement>(".ws-project-name")?.textContent?.trim() ??
            "Project");
      s.ghost = buildGhost(label);
    } else {
      s.sourceEl.classList.add("dragging");
      const label =
        s.sourceEl.querySelector<HTMLElement>(".ws-workspace-name")?.textContent?.trim() ??
        "Workspace";
      s.ghost = buildGhost(label);
    }
    // Routes every subsequent pointermove/pointerup to panelRoot regardless
    // of where the cursor wanders.
    try {
      panelRoot.setPointerCapture(s.pointerId);
    } catch {
      // Some webviews reject capture if the pointer was already released.
    }
  };

  const updateHover = (s: Session, clientX: number, clientY: number): void => {
    // Ghost is pointer-events: none so this resolves the real element behind
    // the cursor (NOT the ghost itself).
    const hoverEl = document.elementFromPoint(clientX, clientY);
    if (!(hoverEl instanceof HTMLElement)) {
      visuals.clear();
      return;
    }
    if (s.kind === "project") {
      const zone = resolveProjectDropZone(hoverEl);
      if (!zone) {
        visuals.clear();
        return;
      }
      visuals.setDropTarget(zone.wsWrap);
      visuals.showInsertionLine(zone.list, clientY, ".ws-project-row", s.idSet);
      return;
    }
    const body = hoverEl.closest<HTMLElement>(".ws-panel-body");
    if (!body) {
      visuals.clear();
      return;
    }
    visuals.setDropTarget(null);
    visuals.showInsertionLine(body, clientY, ".ws-workspace", s.idSet);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!session) return;
    if (session.pointerId !== e.pointerId) return;

    if (!session.committed) {
      const dx = e.clientX - session.startX;
      const dy = e.clientY - session.startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
      commitSession(session);
    }

    if (session.ghost) moveGhost(session.ghost, e.clientX, e.clientY);
    updateHover(session, e.clientX, e.clientY);
  };

  const finishDrop = (s: Session, clientX: number, clientY: number): void => {
    // Hide the ghost BEFORE elementFromPoint so it doesn't shadow the real
    // target (pointer-events: none should already prevent that but the
    // ghost might still be on the topmost layer in some webviews).
    s.ghost?.remove();
    s.ghost = null;
    const hoverEl = document.elementFromPoint(clientX, clientY);
    if (!(hoverEl instanceof HTMLElement)) {
      visuals.clear();
      return;
    }

    if (s.kind === "project") {
      const zone = resolveProjectDropZone(hoverEl);
      if (!zone) {
        visuals.clear();
        return;
      }
      const toWorkspace = zone.list.dataset.workspaceId as WorkspaceId | undefined;
      if (!toWorkspace) {
        visuals.clear();
        return;
      }
      const index = computeInsertionIndex(zone.list, clientY, ".ws-project-row", s.idSet);
      const ids = s.ids;
      if (ids.length > 1 || toWorkspace !== s.fromWorkspace) {
        controller.moveProjects(ids, toWorkspace, index);
      } else {
        const allIds = currentOrder<ProjectId>(zone.list, ".ws-project-row");
        const onlyId = ids[0];
        const cur = allIds.indexOf(onlyId);
        if (cur >= 0) allIds.splice(cur, 1);
        allIds.splice(index, 0, onlyId);
        controller.reorderProjects(toWorkspace, allIds);
      }
      visuals.clear();
      return;
    }

    const body = hoverEl.closest<HTMLElement>(".ws-panel-body");
    if (!body) {
      visuals.clear();
      return;
    }
    const wsId = s.sourceId;
    const ids = currentOrder<WorkspaceId>(body, ".ws-workspace");
    const index = computeInsertionIndex(body, clientY, ".ws-workspace", s.idSet);
    const cur = ids.indexOf(wsId);
    if (cur >= 0) ids.splice(cur, 1);
    ids.splice(index, 0, wsId);
    controller.reorderWorkspaces(ids);
    visuals.clear();
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!session) return;
    if (session.pointerId !== e.pointerId) return;
    const s = session;
    session = null;
    try {
      panelRoot.releasePointerCapture(s.pointerId);
    } catch {
      // No capture was claimed (threshold never crossed) — fine.
    }
    if (!s.committed) {
      // It was a click. Cleanup leftover visuals defensively; let the row's
      // click handler run normally.
      cleanupSession(s);
      return;
    }
    suppressNextClick();
    finishDrop(s, e.clientX, e.clientY);
    panelRoot.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
  };

  const onPointerCancel = (e: PointerEvent): void => {
    if (!session) return;
    if (session.pointerId !== e.pointerId) return;
    const s = session;
    session = null;
    try {
      panelRoot.releasePointerCapture(s.pointerId);
    } catch {
      // ignore
    }
    cleanupSession(s);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !session) return;
    const s = session;
    session = null;
    try {
      panelRoot.releasePointerCapture(s.pointerId);
    } catch {
      // ignore
    }
    cleanupSession(s);
  };

  panelRoot.addEventListener("pointerdown", onPointerDown);
  panelRoot.addEventListener("pointermove", onPointerMove);
  panelRoot.addEventListener("pointerup", onPointerUp);
  panelRoot.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("keydown", onKeyDown);

  return {
    detach(): void {
      panelRoot.removeEventListener("pointerdown", onPointerDown);
      panelRoot.removeEventListener("pointermove", onPointerMove);
      panelRoot.removeEventListener("pointerup", onPointerUp);
      panelRoot.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown);
      if (session) {
        cleanupSession(session);
        session = null;
      }
      visuals.clear();
      panelRoot.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
    },
  };
}

function orderedSelectedInPanel(root: HTMLElement, selected: ReadonlySet<ProjectId>): ProjectId[] {
  const out: ProjectId[] = [];
  root.querySelectorAll<HTMLElement>(".ws-project-row[data-project-id]").forEach((row) => {
    const pid = row.dataset.projectId as ProjectId | undefined;
    if (pid && selected.has(pid)) out.push(pid);
  });
  return out;
}

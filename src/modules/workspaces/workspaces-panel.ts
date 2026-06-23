import { attach as attachDragDrop, type DragDropHandle } from "./drag-drop";
import { createWorkspaceRow, type WorkspaceRowHandle } from "./workspace-row";
import { createSidebarEmptyState, type EmptyStateHandle } from "./workspaces-empty-state";
import { sortedWorkspaces } from "./workspaces-reducer";
import type { ProjectId } from "./types";
import type { WorkspacesController } from "./workspaces-controller";

/**
 * Live-count surface the panel needs from the TerminalRouter. Kept as a
 * minimal structural type so the panel does not depend on the router class
 * directly (avoids an import cycle and keeps the module testable in isolation).
 */
export interface LiveCountSource {
  getCount(projectId: ProjectId): number;
  liveCountsByProject(): ReadonlyMap<ProjectId, number>;
  on(
    listener: (event: { type: "counts-changed"; counts: ReadonlyMap<ProjectId, number> }) => void,
  ): () => void;
}

export interface WorkspacesPanelOptions {
  root: HTMLElement;
  controller: WorkspacesController;
  /** Optional. When provided, the panel surfaces live PTY counts in badges. */
  liveCounts?: LiveCountSource;
}

export interface WorkspacesPanelHandle {
  unmount(): void;
}

/**
 * Mounts the workspaces tree into `root`. The orchestrator is intentionally
 * thin: it only renders the header + scrollable body, hands children off to
 * `createWorkspaceRow`, and re-renders the body in response to
 * `controller.on('state-changed', ...)`. When a `liveCounts` source is given,
 * the panel also subscribes to its `counts-changed` event and fans badge
 * updates out to the matching rows without re-rendering the panel.
 */
export function mountWorkspacesPanel(opts: WorkspacesPanelOptions): WorkspacesPanelHandle {
  const { root, controller, liveCounts } = opts;

  const previousContent = Array.from(root.childNodes);
  root.replaceChildren();
  root.classList.add("ws-panel");

  const header = document.createElement("div");
  header.className = "ws-panel-header";

  const title = document.createElement("div");
  title.className = "ws-panel-title";
  title.textContent = "workspaces";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "ws-panel-add";
  addBtn.title = "New workspace";
  addBtn.textContent = "+";

  header.append(title, addBtn);

  const body = document.createElement("div");
  body.className = "ws-panel-body";

  root.append(header, body);

  const handles: WorkspaceRowHandle[] = [];
  let emptyState: EmptyStateHandle | null = null;

  const onAddClick = (): void => {
    void controller.createWorkspaceInteractive();
  };
  addBtn.addEventListener("click", onAddClick);

  const dnd: DragDropHandle = attachDragDrop(body, { controller });

  const liveCountFor = (projectId: ProjectId): number => liveCounts?.getCount(projectId) ?? 0;

  const render = (): void => {
    for (const handle of handles.splice(0)) handle.dispose();
    if (emptyState) {
      emptyState.dispose();
      emptyState = null;
    }
    body.replaceChildren();

    const state = controller.getState();
    if (state.workspaces.length === 0) {
      emptyState = createSidebarEmptyState(controller);
      body.append(emptyState.element);
      return;
    }

    for (const workspace of sortedWorkspaces(state)) {
      const handle = createWorkspaceRow({
        workspace,
        controller,
        liveCountFor: liveCounts ? liveCountFor : undefined,
      });
      handles.push(handle);
      body.append(handle.element);
    }
  };

  render();

  const unsubscribeController = controller.on((event) => {
    if (event.type !== "state-changed") return;
    render();
  });

  const unsubscribeCounts =
    liveCounts?.on((event) => {
      if (event.type !== "counts-changed") return;
      for (const [projectId, count] of event.counts) {
        for (const handle of handles) handle.setLiveCount(projectId, count);
      }
    }) ?? null;

  return {
    unmount(): void {
      unsubscribeController();
      unsubscribeCounts?.();
      dnd.detach();
      addBtn.removeEventListener("click", onAddClick);
      for (const handle of handles.splice(0)) handle.dispose();
      emptyState?.dispose();
      emptyState = null;
      root.replaceChildren(...previousContent);
      root.classList.remove("ws-panel");
    },
  };
}

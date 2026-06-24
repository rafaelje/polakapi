import { showToast } from "../../shared/ui/toast";
import { attach as attachDragDrop, type DragDropHandle } from "./drag-drop";
import { attachFinderDrop, type FinderDropHandle } from "./finder-drop";
import { matchesProject } from "./project-filter";
import { validatePath } from "./path-validation";
import { createSelectionStore } from "./selection";
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
/**
 * Live-count event the panel cares about. Kept as a discriminated union with
 * an open shape so callers (the TerminalRouter) can emit additional variants
 * — only `counts-changed` is consumed here.
 */
export type LiveCountEvent =
  | { type: "counts-changed"; counts: ReadonlyMap<ProjectId, number> }
  | { type: string; [key: string]: unknown };

export interface LiveCountSource {
  getCount(projectId: ProjectId): number;
  liveCountsByProject(): ReadonlyMap<ProjectId, number>;
  on(listener: (event: LiveCountEvent) => void): () => void;
}

/**
 * F5: optional bell-pending stream the panel forwards to project rows. Kept
 * structural (and decoupled from TerminalRouter) so the panel module remains
 * unit-testable without the router dependency.
 */
export interface BellPendingSource {
  on(
    listener: (event: {
      type: "bell-pending";
      projectId: ProjectId;
      paneId: string;
      pending: boolean;
    }) => void,
  ): () => void;
}

export interface WorkspacesPanelOptions {
  root: HTMLElement;
  controller: WorkspacesController;
  /** Optional. When provided, the panel surfaces live PTY counts in badges. */
  liveCounts?: LiveCountSource;
  /** Optional. When provided, the panel toggles `.has-bell` on rows. */
  bellSource?: BellPendingSource;
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
  const { root, controller, liveCounts, bellSource } = opts;

  const previousContent = Array.from(root.childNodes);
  root.replaceChildren();
  root.classList.add("ws-panel");

  const header = document.createElement("div");
  header.className = "ws-panel-header";

  const title = document.createElement("div");
  title.className = "ws-panel-title";
  title.textContent = "workspaces";

  const search = document.createElement("input");
  search.type = "search";
  search.className = "ws-panel-search";
  search.placeholder = "Filter projects…";
  search.setAttribute("aria-label", "Filter projects");
  search.autocomplete = "off";
  search.spellcheck = false;

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "ws-panel-add";
  addBtn.title = "New workspace";
  addBtn.textContent = "+";

  header.append(title, search, addBtn);

  const body = document.createElement("div");
  body.className = "ws-panel-body";

  root.append(header, body);

  const handles: WorkspaceRowHandle[] = [];
  let emptyState: EmptyStateHandle | null = null;
  let query = "";
  const selection = createSelectionStore();

  const onAddClick = (): void => {
    void controller.createWorkspaceInteractive();
  };
  addBtn.addEventListener("click", onAddClick);

  const onSearchInput = (): void => {
    query = search.value;
    render();
  };
  search.addEventListener("input", onSearchInput);

  // Clear the multi-selection when the user clicks the panel chrome (header,
  // body background, between rows) without a modifier. Row clicks stop short
  // of "outside" because they sit deeper in the tree and either set the
  // selection themselves or get caught by capture-phase preventDefault.
  const onPanelClick = (e: MouseEvent): void => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".ws-project-row")) return;
    selection.clear();
  };
  root.addEventListener("click", onPanelClick);

  const dnd: DragDropHandle = attachDragDrop(body, { controller, selection });
  // F4 Feature 2: native Finder drag&drop of folders into workspaces. The
  // highlight reuses `.ws-drop-target` so the visual language matches the
  // in-app dnd above.
  const finderDrop: FinderDropHandle = attachFinderDrop(body, {
    controller,
    validatePath,
    toast: (msg, kind) => showToast(msg, kind ?? "info"),
  });

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

    const activeQuery = query.trim();
    for (const workspace of sortedWorkspaces(state)) {
      // When a search is active, skip workspaces that have no matching
      // projects entirely — the row helper would render an empty header
      // with no children, which is noise.
      if (activeQuery) {
        const hasMatch = workspace.projects.some((p) =>
          matchesProject(activeQuery, workspace.name, p),
        );
        if (!hasMatch) continue;
      }
      const handle = createWorkspaceRow({
        workspace,
        controller,
        liveCountFor: liveCounts ? liveCountFor : undefined,
        filterQuery: activeQuery,
        selection,
      });
      handles.push(handle);
      body.append(handle.element);
    }
  };

  render();

  const unsubscribeController = controller.on((event) => {
    if (event.type !== "state-changed") return;
    // GC selection: drop ids that no longer exist (project deleted, moved
    // workspace deleted, etc.) before re-rendering.
    const validIds = new Set<ProjectId>();
    for (const w of event.state.workspaces) for (const p of w.projects) validIds.add(p.id);
    selection.prune(validIds);
    render();
  });

  const unsubscribeCounts =
    liveCounts?.on((event) => {
      if (event.type !== "counts-changed") return;
      const counts = (event as { counts: ReadonlyMap<ProjectId, number> }).counts;
      for (const [projectId, count] of counts) {
        for (const handle of handles) handle.setLiveCount(projectId, count);
      }
    }) ?? null;

  // F5: coalesce rapid bells at the panel layer. The router emits one event
  // per pane bell; the row only cares whether ANY of its panes has a pending
  // bell. We map projectId → Set<paneId> of pending panes; the row class is
  // toggled on the size transition 0↔1.
  const pendingByProject = new Map<ProjectId, Set<string>>();
  const unsubscribeBells =
    bellSource?.on((event) => {
      if (event.type !== "bell-pending") return;
      let set = pendingByProject.get(event.projectId);
      const wasPending = (set?.size ?? 0) > 0;
      if (event.pending) {
        if (!set) {
          set = new Set();
          pendingByProject.set(event.projectId, set);
        }
        set.add(event.paneId);
      } else if (set) {
        // pending=false with paneId clears that pane only; pending=false with
        // an empty paneId (sent by the activation reset) clears everything.
        if (event.paneId) set.delete(event.paneId);
        else set.clear();
      }
      const isPending = (pendingByProject.get(event.projectId)?.size ?? 0) > 0;
      if (wasPending === isPending) return;
      for (const handle of handles) handle.setBellPending(event.projectId, isPending);
    }) ?? null;

  return {
    unmount(): void {
      unsubscribeController();
      unsubscribeCounts?.();
      unsubscribeBells?.();
      finderDrop.detach();
      dnd.detach();
      addBtn.removeEventListener("click", onAddClick);
      search.removeEventListener("input", onSearchInput);
      root.removeEventListener("click", onPanelClick);
      selection.clear();
      for (const handle of handles.splice(0)) handle.dispose();
      emptyState?.dispose();
      emptyState = null;
      pendingByProject.clear();
      root.replaceChildren(...previousContent);
      root.classList.remove("ws-panel");
    },
  };
}

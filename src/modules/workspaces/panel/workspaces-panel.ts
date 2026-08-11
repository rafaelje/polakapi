import { showToast } from "../../../shared/ui/toast";
import { attach as attachDragDrop, type DragDropHandle } from "../drag-drop/drag-drop";
import { attachFinderDrop, type FinderDropHandle } from "../drag-drop/finder-drop";
import { matchesProject } from "../project-filter";
import { validatePath } from "../path-validation";
import { createSelectionStore } from "../state/selection";
import { createWorkspaceRow, type WorkspaceRowHandle } from "./workspace-row";
import { createSidebarEmptyState, type EmptyStateHandle } from "./workspaces-empty-state";
import { sortedWorkspaces } from "../state/workspaces-reducer";
import type { ProjectActivityState } from "../../terminal/project-activity";
import type { Project, ProjectId } from "../state/types";
import type { WorkspacesController } from "../state/workspaces-controller";

/**
 * Terminal event the panel cares about. Kept as a discriminated union with
 * an open shape so callers (the TerminalRouter) can emit additional variants
 * without coupling the panel to the router class.
 */
export type LiveCountEvent =
  | { type: "counts-changed"; counts: ReadonlyMap<ProjectId, number> }
  | { type: "activity-changed"; projectId: ProjectId; state: ProjectActivityState }
  | { type: string; [key: string]: unknown };

export interface LiveCountSource {
  getCount(projectId: ProjectId): number;
  liveCountsByProject(): ReadonlyMap<ProjectId, number>;
  on(listener: (event: LiveCountEvent) => void): () => void;
  getActivity?(projectId: ProjectId): ProjectActivityState;
  /** Optional — feeds the "Resume terminals (N)" row-menu item. */
  getSuspendedCount?(projectId: ProjectId): number;
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
  /** Optional. Surfaces live PTY counts and project activity. */
  liveCounts?: LiveCountSource;
  /** Optional. When provided, the panel toggles `.has-bell` on rows. */
  bellSource?: BellPendingSource;
  activeOnlyToggle: HTMLInputElement;
  onSuspendProject?: (projectId: ProjectId) => void;
  onResumeProject?: (projectId: ProjectId) => void;
}

export interface WorkspacesPanelHandle {
  unmount(): void;
}

/**
 * Mounts the workspaces tree into `root`. The orchestrator is intentionally
 * thin: it only renders the header + scrollable body, hands children off to
 * `createWorkspaceRow`, and re-renders the body in response to
 * `controller.on('state-changed', ...)`. When a `liveCounts` source is given,
 * the panel also fans count and activity updates out to matching rows without
 * re-rendering the panel.
 */
export function mountWorkspacesPanel(opts: WorkspacesPanelOptions): WorkspacesPanelHandle {
  const { root, controller, liveCounts, bellSource, activeOnlyToggle } = opts;

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

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "ws-panel-collapse";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "ws-panel-add";
  addBtn.title = "New workspace";
  addBtn.textContent = "+";

  header.append(title, search, collapseBtn, addBtn);

  const syncCollapseBtn = (): void => {
    const allCollapsed = controller.areAllCollapsed();
    collapseBtn.textContent = allCollapsed ? "⊞" : "⊟";
    collapseBtn.title = allCollapsed ? "Expand all workspaces" : "Collapse all workspaces";
  };
  const onCollapseClick = (): void => {
    controller.setAllCollapsed(!controller.areAllCollapsed());
  };
  collapseBtn.addEventListener("click", onCollapseClick);

  const liveCountFor = (projectId: ProjectId): number => liveCounts?.getCount(projectId) ?? 0;
  const suspendedCountFor = (projectId: ProjectId): number =>
    liveCounts?.getSuspendedCount?.(projectId) ?? 0;
  const activityFor = (projectId: ProjectId): ProjectActivityState =>
    liveCounts?.getActivity?.(projectId) ?? "idle";

  const body = document.createElement("div");
  body.className = "ws-panel-body";

  root.append(header, body);

  const handles: WorkspaceRowHandle[] = [];
  let emptyState: EmptyStateHandle | null = null;
  let query = "";
  let activeOnly = activeOnlyToggle.checked;
  const selection = createSelectionStore();
  const pendingByProject = new Map<ProjectId, Set<string>>();

  const deleteSelected = (): void => {
    const ids = [...selection.getSelected()];
    if (ids.length === 0) return;
    const total = ids.reduce((sum, id) => sum + liveCountFor(id), 0);
    void controller
      .deleteProjectsWithLiveCount(ids, total)
      .then((ok) => {
        if (ok) selection.clear();
      })
      .catch(() => {
        showToast("Failed to delete the selected projects", "error");
      });
  };

  const onAddClick = (): void => {
    void controller.createWorkspaceInteractive();
  };
  addBtn.addEventListener("click", onAddClick);

  const onSearchInput = (): void => {
    query = search.value;
    render();
  };
  search.addEventListener("input", onSearchInput);

  const onActiveOnlyChange = (): void => {
    activeOnly = activeOnlyToggle.checked;
    render();
  };
  activeOnlyToggle.addEventListener("change", onActiveOnlyChange);

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

  const render = (): void => {
    syncCollapseBtn();
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
    const matchesActiveFilter = (project: Project): boolean =>
      !activeOnly || liveCountFor(project.id) > 0;
    for (const workspace of sortedWorkspaces(state)) {
      // When a search is active, skip workspaces that have no matching
      // projects entirely — the row helper would render an empty header
      // with no children, which is noise.
      if (activeQuery || activeOnly) {
        const hasMatch = workspace.projects.some(
          (project) =>
            matchesActiveFilter(project) &&
            (!activeQuery || matchesProject(activeQuery, workspace.name, project)),
        );
        if (!hasMatch) continue;
      }
      const handle = createWorkspaceRow({
        workspace,
        controller,
        liveCountFor: liveCounts ? liveCountFor : undefined,
        activityFor: liveCounts ? activityFor : undefined,
        bellPendingFor: (projectId) => (pendingByProject.get(projectId)?.size ?? 0) > 0,
        getSuspendedCount: liveCounts ? suspendedCountFor : undefined,
        filterQuery: activeQuery,
        projectFilter: activeOnly ? matchesActiveFilter : undefined,
        selection,
        onSuspendProject: opts.onSuspendProject,
        onResumeProject: opts.onResumeProject,
        onDeleteSelected: deleteSelected,
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

  const unsubscribeTerminalEvents =
    liveCounts?.on((event) => {
      if (event.type === "counts-changed") {
        if (activeOnly) {
          render();
          return;
        }
        const counts = (event as { counts: ReadonlyMap<ProjectId, number> }).counts;
        for (const [projectId, count] of counts) {
          for (const handle of handles) handle.setLiveCount(projectId, count);
        }
      } else if (event.type === "activity-changed") {
        const activity = event as {
          projectId: ProjectId;
          state: ProjectActivityState;
        };
        for (const handle of handles) handle.setActivity(activity.projectId, activity.state);
      }
    }) ?? null;

  // F5: coalesce rapid bells at the panel layer. The router emits one event
  // per pane bell; the row only cares whether ANY of its panes has a pending
  // bell. We map projectId → Set<paneId> of pending panes; the row class is
  // toggled on the size transition 0↔1.
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
      unsubscribeTerminalEvents?.();
      unsubscribeBells?.();
      finderDrop.detach();
      dnd.detach();
      addBtn.removeEventListener("click", onAddClick);
      collapseBtn.removeEventListener("click", onCollapseClick);
      search.removeEventListener("input", onSearchInput);
      activeOnlyToggle.removeEventListener("change", onActiveOnlyChange);
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

import { promptModal } from "../../../shared/ui/modal";
import { showToast } from "../../../shared/ui/toast";
import { deterministicColor } from "../appearance-defaults";
import { openAppearancePicker } from "../forms/appearance-picker";
import { createFolderRow, type FolderRowHandle } from "./folder-row";
import { createProjectRow, createShortcutHint, type ProjectRowHandle } from "./project-row";
import { matchesProject } from "../project-filter";
import { openRowMenu } from "../forms/row-menu";
import { startInlineRename } from "../forms/rename-inline";
import { normalizeShortcutKey } from "../state/workspaces-reducer-shortcuts";
import type { ProjectActivityState } from "../../terminal/project-activity";
import type { SelectionStore } from "../state/selection";
import type { Project, ProjectId, Workspace } from "../state/types";
import type { WorkspacesController } from "../state/workspaces-controller";
import { compareByOrderThenName } from "../state/workspaces-reducer-helpers";
import { sortedWorkspaceEntries } from "../state/workspaces-reducer";

const WORKSPACE_CLICK_DELAY_MS = 280;

export interface WorkspaceRowOptions {
  workspace: Workspace;
  controller: WorkspacesController;
  /**
   * Resolves the live-terminal count for any project in this workspace at
   * render time. The panel feeds router.getCount via this callback so newly
   * created rows already show the right badge before the next event fires.
   */
  liveCountFor?: (projectId: ProjectId) => number;
  activityFor?: (projectId: ProjectId) => ProjectActivityState;
  bellPendingFor?: (projectId: ProjectId) => boolean;
  /** Resolves the suspended-terminal count; feeds "Resume terminals (N)". */
  getSuspendedCount?: (projectId: ProjectId) => number;
  /**
   * Optional sidebar search query. When non-empty, only projects matching the
   * query are rendered. Workspaces with zero matches are hidden by the panel.
   */
  filterQuery?: string;
  projectFilter?: (project: Project) => boolean;
  /** Multi-selection store shared across all rows. */
  selection: SelectionStore;
  onSuspendProject?: (projectId: ProjectId) => void;
  onResumeProject?: (projectId: ProjectId) => void;
  onDeleteSelected?: () => void;
}

export interface WorkspaceRowHandle {
  element: HTMLElement;
  /**
   * Update the live-terminal badge for one of this workspace's projects.
   * No-op when the project is not currently rendered under this row.
   */
  setLiveCount(projectId: ProjectId, n: number): void;
  setActivity(projectId: ProjectId, state: ProjectActivityState): void;
  /** Forward a bell-pending toggle to the matching project row. */
  setBellPending(projectId: ProjectId, pending: boolean): void;
  dispose(): void;
}

/**
 * Renders a workspace header plus its sorted list of projects. The row owns
 * the lifecycles of every child `ProjectRow` and tears them all down on
 * `dispose()`.
 */
export function createWorkspaceRow(opts: WorkspaceRowOptions): WorkspaceRowHandle {
  const { workspace, controller } = opts;

  const wrapper = document.createElement("div");
  wrapper.className = "ws-workspace";
  wrapper.dataset.workspaceId = workspace.id;
  // F4: tint the workspace row using the explicit color, or a stable
  // deterministic fallback derived from the id. CSS maps [data-color="X"] to
  // var(--ws-color-X) — see styles.css.
  wrapper.dataset.color = workspace.color ?? deterministicColor(workspace.id);
  if (workspace.collapsed) wrapper.classList.add("collapsed");

  const header = document.createElement("div");
  header.className = "ws-workspace-header";

  const chevron = document.createElement("button");
  chevron.type = "button";
  chevron.className = "ws-chevron";
  chevron.title = workspace.collapsed ? "Expand workspace" : "Collapse workspace";
  chevron.textContent = workspace.collapsed ? "▸" : "▾";

  const name = document.createElement("span");
  name.className = "ws-workspace-name";
  name.textContent = workspace.name;
  const setNameInteractive = (interactive: boolean): void => {
    if (interactive) {
      name.tabIndex = 0;
      name.setAttribute("role", "button");
      name.setAttribute("aria-expanded", String(!workspace.collapsed));
      name.title = "Click to collapse or expand. Double-click to rename.";
      return;
    }
    name.removeAttribute("tabindex");
    name.removeAttribute("role");
    name.removeAttribute("aria-expanded");
    name.removeAttribute("title");
  };
  setNameInteractive(true);

  const activitySummary = document.createElement("span");
  activitySummary.className = "ws-workspace-activity";
  const activityDot = document.createElement("span");
  activityDot.className = "ws-workspace-activity-dot";
  const activityLabel = document.createElement("span");
  activitySummary.append(activityDot, activityLabel);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "ws-row-add";
  addBtn.title = "Add project to this workspace";
  addBtn.textContent = "+";

  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "ws-row-kebab";
  menuBtn.title = "Workspace actions";
  menuBtn.textContent = "⋮";

  header.append(chevron, name);
  if (workspace.shortcut) header.append(createShortcutHint(workspace.shortcut));
  header.append(activitySummary, addBtn, menuBtn);
  wrapper.append(header);

  const projectsList = document.createElement("div");
  projectsList.className = "ws-projects";
  projectsList.dataset.workspaceId = workspace.id;
  wrapper.append(projectsList);

  const projectHandles = new Map<ProjectId, ProjectRowHandle>();
  const ownProjectIds = new Set<ProjectId>();
  const folderHandles: FolderRowHandle[] = [];
  const activeProjectId = controller.getState().activeProjectId;
  const liveCountFor = opts.liveCountFor;
  const suspendedCountFor = opts.getSuspendedCount;
  const activeQuery = opts.filterQuery ?? "";
  const projectActivities = new Map<ProjectId, ProjectActivityState>();
  for (const project of workspace.projects) {
    if (opts.projectFilter && !opts.projectFilter(project)) continue;
    projectActivities.set(project.id, opts.activityFor?.(project.id) ?? "idle");
  }
  const bellPendingProjects = new Set<ProjectId>();
  for (const project of workspace.projects) {
    if (opts.bellPendingFor?.(project.id)) bellPendingProjects.add(project.id);
  }

  const syncActivitySummary = (): void => {
    const attention = bellPendingProjects.size;
    const working = [...projectActivities.values()].filter((state) => state === "working").length;
    const ready = [...projectActivities.values()].filter((state) => state === "ready").length;
    const recent = [...projectActivities.values()].filter((state) => state === "recent").length;
    let state: "attention" | ProjectActivityState = "idle";
    let text = "";
    if (attention > 0) {
      state = "attention";
      text = `${attention} need${attention === 1 ? "s" : ""} attention`;
    } else if (working > 0) {
      state = "working";
      text = `${working} working`;
    } else if (ready > 0) {
      state = "ready";
      text = `${ready} active`;
    } else if (recent > 0) {
      state = "recent";
      text = `${recent} recent`;
    }
    activitySummary.dataset.activity = state;
    activitySummary.classList.toggle("hidden", state === "idle");
    activityLabel.textContent = text;
    activitySummary.title = text;
  };
  syncActivitySummary();

  const folderCount = (workspace.folders ?? []).length;
  const sortedFolderIds = [...(workspace.folders ?? [])]
    .sort(compareByOrderThenName)
    .map((f) => f.id);

  for (const entry of sortedWorkspaceEntries(workspace)) {
    if (entry.kind === "project") {
      if (opts.projectFilter && !opts.projectFilter(entry.project)) continue;
      // Search filtering for ungrouped projects, applied per-entry (same
      // matching rule `filterProjects` uses for the whole list).
      if (activeQuery && !matchesProject(activeQuery, workspace.name, entry.project)) continue;
      const project = entry.project;
      const initialCount = liveCountFor ? liveCountFor(project.id) : 0;
      const handle = createProjectRow({
        onSuspendProject: opts.onSuspendProject,
        onResumeProject: opts.onResumeProject,
        onDeleteSelected: opts.onDeleteSelected,
        project,
        workspaceId: workspace.id,
        isActive: activeProjectId === project.id,
        liveTerminalsCount: initialCount,
        activityState: projectActivities.get(project.id) ?? "idle",
        bellPending: bellPendingProjects.has(project.id),
        controller,
        getLiveCount: liveCountFor ? () => liveCountFor(project.id) : undefined,
        getSuspendedCount: suspendedCountFor ? () => suspendedCountFor(project.id) : undefined,
        selection: opts.selection,
      });
      projectHandles.set(project.id, handle);
      ownProjectIds.add(project.id);
      projectsList.append(handle.element);
      continue;
    }

    const folder = entry.folder;
    const folderIdx = sortedFolderIds.indexOf(folder.id);
    // Skip a folder entirely when a search is active and none of its
    // projects match — same "hide empty groups" rule the panel already
    // applies to whole workspaces.
    if (activeQuery || opts.projectFilter) {
      const hasMatch = workspace.projects.some(
        (project) =>
          project.folderId === folder.id &&
          (!opts.projectFilter || opts.projectFilter(project)) &&
          (!activeQuery || matchesProject(activeQuery, workspace.name, project)),
      );
      if (!hasMatch) continue;
    }
    const folderHandle = createFolderRow({
      folder,
      workspace,
      controller,
      liveCountFor: opts.liveCountFor,
      activityFor: opts.activityFor,
      bellPendingFor: opts.bellPendingFor,
      getSuspendedCount: opts.getSuspendedCount,
      filterQuery: opts.filterQuery,
      projectFilter: opts.projectFilter,
      selection: opts.selection,
      onSuspendProject: opts.onSuspendProject,
      onResumeProject: opts.onResumeProject,
      onDeleteSelected: opts.onDeleteSelected,
      isFirst: folderIdx === 0,
      isLast: folderIdx === folderCount - 1,
    });
    folderHandles.push(folderHandle);
    for (const [pid, handle] of folderHandle.projectHandles) projectHandles.set(pid, handle);
    projectsList.append(folderHandle.element);
  }

  const listeners: Array<() => void> = [];
  let collapseTimer: ReturnType<typeof setTimeout> | null = null;
  const clearCollapseTimer = (): void => {
    if (collapseTimer === null) return;
    clearTimeout(collapseTimer);
    collapseTimer = null;
  };
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
  ): void => {
    el.addEventListener(type, handler);
    listeners.push(() => el.removeEventListener(type, handler));
  };

  on(chevron, "click", (e) => {
    e.stopPropagation();
    controller.toggleCollapsed(workspace.id);
  });

  on(name, "click", (e) => {
    if (e.target !== name) return;
    if (e.detail > 1) {
      clearCollapseTimer();
      return;
    }
    clearCollapseTimer();
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      controller.toggleCollapsed(workspace.id);
    }, WORKSPACE_CLICK_DELAY_MS);
  });

  on(name, "dblclick", (e) => {
    if (e.target !== name) return;
    e.preventDefault();
    e.stopPropagation();
    clearCollapseTimer();
    void runRename();
  });

  on(name, "keydown", (e) => {
    if (e.target !== name) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      clearCollapseTimer();
      controller.toggleCollapsed(workspace.id);
    } else if (e.key === "F2") {
      e.preventDefault();
      clearCollapseTimer();
      void runRename();
    }
  });

  on(addBtn, "click", (e) => {
    e.stopPropagation();
    void controller.createProjectInteractive(workspace.id);
  });

  on(menuBtn, "click", (e) => {
    e.stopPropagation();
    openWorkspaceMenu();
  });

  function openWorkspaceMenu(): void {
    openRowMenu({
      trigger: menuBtn,
      items: [
        { label: "Rename", onSelect: () => void runRename() },
        {
          label: "Add project…",
          onSelect: () => void controller.createProjectInteractive(workspace.id),
        },
        {
          label: "New folder…",
          onSelect: () => void controller.createFolderInteractive(workspace.id),
        },
        {
          label: "Clone repo…",
          onSelect: () => void controller.cloneRepoInteractive(workspace.id),
        },
        {
          label: workspace.collapsed ? "Expand" : "Collapse",
          onSelect: () => controller.toggleCollapsed(workspace.id),
        },
        {
          label: "Sort projects alphabetically",
          onSelect: () => controller.resetAlphabeticalOrder(workspace.id),
        },
        {
          label: "Appearance…",
          onSelect: () => openAppearance(),
        },
        {
          label: workspace.shortcut
            ? `Shortcut… (Ctrl+Alt+${workspace.shortcut.toUpperCase()})`
            : "Shortcut…",
          onSelect: () => void runAssignShortcut(),
        },
        {
          label: "Delete workspace",
          danger: true,
          onSelect: () => void controller.deleteWorkspace(workspace.id),
        },
      ],
    });
  }

  let renaming = false;
  async function runRename(): Promise<void> {
    if (renaming) return;
    renaming = true;
    clearCollapseTimer();
    setNameInteractive(false);
    try {
      const next = await startInlineRename({
        target: name,
        initialValue: workspace.name,
        placeholder: "Workspace name",
      });
      if (next && next !== workspace.name) {
        controller.renameWorkspace(workspace.id, next);
      }
    } finally {
      renaming = false;
      setNameInteractive(true);
    }
  }

  async function runAssignShortcut(): Promise<void> {
    const next = await promptModal({
      title: "Assign shortcut",
      message:
        "One letter or digit — Ctrl+Alt+<key> activates this workspace's first project. Empty clears.",
      placeholder: "e.g. w",
      initialValue: workspace.shortcut ?? "",
      confirmLabel: "Assign",
    });
    if (next === null) return;
    if (!next.trim()) {
      controller.setWorkspaceShortcut(workspace.id, undefined);
      return;
    }
    const key = normalizeShortcutKey(next);
    if (!key) {
      showToast("Shortcut must be a single letter or digit", "error");
      return;
    }
    controller.setWorkspaceShortcut(workspace.id, key);
  }

  // Track the currently open appearance picker so we can tear it down on row
  // dispose (e.g. when the workspace tree re-renders mid-edit).
  let appearancePicker: { dispose(): void } | null = null;
  function openAppearance(): void {
    appearancePicker?.dispose();
    appearancePicker = openAppearancePicker({
      trigger: menuBtn,
      currentColor: workspace.color,
      onPickColor: (color) => controller.setWorkspaceColor(workspace.id, color),
    });
  }

  return {
    element: wrapper,
    setLiveCount(projectId: ProjectId, n: number): void {
      projectHandles.get(projectId)?.setLiveCount(n);
    },
    setActivity(projectId: ProjectId, state: ProjectActivityState): void {
      if (!projectActivities.has(projectId)) return;
      projectActivities.set(projectId, state);
      projectHandles.get(projectId)?.setActivity(state);
      syncActivitySummary();
    },
    setBellPending(projectId: ProjectId, pending: boolean): void {
      if (!projectActivities.has(projectId)) return;
      if (pending) bellPendingProjects.add(projectId);
      else bellPendingProjects.delete(projectId);
      projectHandles.get(projectId)?.setBellPending(pending);
      syncActivitySummary();
    },
    dispose(): void {
      clearCollapseTimer();
      appearancePicker?.dispose();
      appearancePicker = null;
      for (const off of listeners.splice(0)) off();
      for (const handle of folderHandles.splice(0)) handle.dispose();
      for (const id of ownProjectIds) projectHandles.get(id)?.dispose();
      ownProjectIds.clear();
      projectHandles.clear();
      projectActivities.clear();
      bellPendingProjects.clear();
      wrapper.remove();
    },
  };
}

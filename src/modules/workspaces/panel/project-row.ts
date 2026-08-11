import { promptModal } from "../../../shared/ui/modal";
import { showToast } from "../../../shared/ui/toast";
import { deterministicColor } from "../appearance-defaults";
import { openAppearancePicker } from "../forms/appearance-picker";
import { openRowMenu } from "../forms/row-menu";
import { startInlineRename } from "../forms/rename-inline";
import { normalizeShortcutKey } from "../state/workspaces-reducer-shortcuts";
import { compareByOrderThenName } from "../state/workspaces-reducer-helpers";
import type { ProjectActivityState } from "../../terminal/project-activity";
import type { SelectionStore } from "../state/selection";
import type { FolderId, Project, ProjectId, Workspace, WorkspaceId } from "../state/types";
import type { WorkspacesController } from "../state/workspaces-controller";

export interface ProjectRowOptions {
  project: Project;
  workspaceId: WorkspaceId;
  isActive: boolean;
  /**
   * Initial live-terminal count for this project. Subsequent updates flow
   * through `ProjectRowHandle.setLiveCount(n)` so the panel can mutate the
   * badge in place instead of re-rendering the whole row.
   */
  liveTerminalsCount: number;
  activityState?: ProjectActivityState;
  bellPending?: boolean;
  controller: WorkspacesController;
  /**
   * Resolves the current live count when the row triggers the delete flow —
   * the confirm modal must show the up-to-date number even if the badge has
   * not been touched since the last render.
   */
  getLiveCount?: () => number;
  /** Resolves the current suspended-terminal count for the "Resume terminals (N)" item. */
  getSuspendedCount?: () => number;
  /**
   * Multi-selection store shared across all rows. Modifier-aware clicks
   * mutate it; rows subscribe to apply the `.selected` visual.
   */
  selection: SelectionStore;
  onSuspendProject?: (projectId: ProjectId) => void;
  onResumeProject?: (projectId: ProjectId) => void;
  onDeleteSelected?: () => void;
}

export interface ProjectRowHandle {
  element: HTMLElement;
  /** Update the live-terminals badge without re-rendering the row. */
  setLiveCount(n: number): void;
  setActivity(state: ProjectActivityState): void;
  /** Show or clear the project's attention state. */
  setBellPending(pending: boolean): void;
  dispose(): void;
}

/**
 * Renders a single project row inside its workspace. The row supports:
 *   - click to activate
 *   - double-click to rename inline
 *   - kebab menu (rename / change path / duplicate / move to / delete)
 *   - invalid-path affordance (re-pick or delete)
 */
export function createProjectRow(opts: ProjectRowOptions): ProjectRowHandle {
  const { project, workspaceId, isActive, controller, selection } = opts;

  const row = document.createElement("div");
  row.className = "ws-project-row";
  if (isActive) row.classList.add("active");
  if (project.pathInvalid) row.classList.add("invalid");
  row.dataset.projectId = project.id;
  row.dataset.workspaceId = workspaceId;
  // Read by drag-drop.ts to know which bucket this row's drag started from.
  if (project.folderId) row.dataset.folderId = project.folderId;
  // F4: same color resolution as workspace-row — explicit override wins,
  // otherwise the deterministic palette so the row still picks up a tint.
  row.dataset.color = project.color ?? deterministicColor(project.id);

  const dot = document.createElement("span");
  dot.className = "ws-active-dot";
  dot.setAttribute("role", "img");

  const labelCol = document.createElement("div");
  labelCol.className = "ws-project-label";

  const nameLine = document.createElement("div");
  nameLine.className = "ws-project-name-line";

  const name = document.createElement("span");
  name.className = "ws-project-name";
  name.textContent = project.name;

  const pathTag = document.createElement("span");
  pathTag.className = "ws-project-path";
  pathTag.textContent = project.path;
  pathTag.title = project.path;

  nameLine.append(name);
  if (project.shortcut) {
    nameLine.append(createShortcutHint(project.shortcut));
  }
  labelCol.append(nameLine, pathTag);

  const badge = document.createElement("span");
  badge.className = "ws-terminals-badge";

  const activityLabel = document.createElement("span");
  activityLabel.className = "ws-activity-label";

  let activityState = opts.activityState ?? "idle";
  let bellPending = opts.bellPending ?? false;
  const applyActivity = (): void => {
    const state = bellPending ? "attention" : activityState;
    const copy = {
      working: { label: "Running", title: "Terminal activity in progress" },
      ready: { label: "Ready", title: "Terminal active and waiting" },
      recent: { label: "Recent", title: "Recently active" },
      idle: { label: "", title: "No terminal activity" },
      attention: { label: "Attention", title: "Terminal needs attention" },
    }[state];
    row.dataset.activity = state;
    activityLabel.textContent = copy.label;
    activityLabel.classList.toggle("hidden", state === "idle");
    dot.setAttribute("aria-label", copy.title);
    dot.title = copy.title;
    row.classList.toggle("has-bell", bellPending);
  };
  applyActivity();

  const applyBadge = (n: number): void => {
    const safe = Math.max(0, Math.floor(n));
    badge.textContent = String(safe);
    badge.classList.toggle("hidden", safe === 0);
    badge.classList.toggle("live", safe > 0);
    badge.title = safe === 1 ? "1 active terminal" : `${safe} active terminals`;
  };
  applyBadge(opts.liveTerminalsCount);

  const warn = document.createElement("button");
  warn.type = "button";
  warn.className = "ws-warn";
  warn.title = "Path invalid — click to fix";
  warn.textContent = "!";
  if (!project.pathInvalid) warn.classList.add("hidden");

  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "ws-row-kebab";
  menuBtn.textContent = "⋮";
  menuBtn.title = "Project actions";

  row.append(dot, labelCol, activityLabel, badge, warn, menuBtn);

  const listeners: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
  ): void => {
    el.addEventListener(type, handler);
    listeners.push(() => el.removeEventListener(type, handler));
  };

  on(row, "mousedown", (e) => {
    if (e.shiftKey) e.preventDefault();
  });

  on(row, "contextmenu", (e) => {
    e.preventDefault();
    // Right-clicking an unselected row selects just it (like a file manager);
    // right-clicking a row already in a multi-selection keeps it, so the menu
    // surfaces the "Delete N selected" action.
    if (!selection.has(project.id)) selection.setSingle(project.id);
    openProjectMenu({ x: e.clientX, y: e.clientY });
  });

  on(row, "click", (e) => {
    if (e.defaultPrevented) return;
    // Modifier-aware multi-select. shift = range, meta/ctrl = toggle. Both
    // skip setActiveProject so the user can build a selection without
    // hijacking the focused-project state.
    if (e.shiftKey) {
      e.preventDefault();
      const orderedIds = readOrderedProjectIds(row.parentElement);
      selection.selectRange(project.id, orderedIds);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      selection.toggle(project.id);
      return;
    }
    selection.setSingle(project.id);
    controller.setActiveProject(project.id);
  });

  on(row, "dblclick", (e) => {
    e.preventDefault();
    void runRename();
  });

  on(menuBtn, "click", (e) => {
    e.stopPropagation();
    openProjectMenu();
  });

  on(warn, "click", (e) => {
    e.stopPropagation();
    openInvalidMenu();
  });

  function openProjectMenu(at?: { x: number; y: number }): void {
    const selectedIds = [...selection.getSelected()];
    const isBulk = selection.has(project.id) && selectedIds.length > 1;
    const bulkTargets = isBulk ? selectedIds : [project.id];
    openRowMenu({
      trigger: menuBtn,
      at,
      items: [
        { label: "Rename", onSelect: () => void runRename() },
        {
          label: "Change path…",
          onSelect: () => void controller.changeProjectPathInteractive(project.id),
        },
        { label: "Duplicate", onSelect: () => controller.duplicateProject(project.id) },
        { label: "Create worktree…", onSelect: () => void runCreateWorktree() },
        ...(opts.onSuspendProject
          ? [
              {
                label: isBulk ? `Suspend terminals (${selectedIds.length})` : "Suspend terminals",
                disabled: !isBulk && (opts.getLiveCount?.() ?? 0) === 0,
                onSelect: () => {
                  for (const id of bulkTargets) opts.onSuspendProject?.(id);
                },
              },
            ]
          : []),
        ...(opts.onResumeProject
          ? [
              {
                label: isBulk ? `Resume terminals (${selectedIds.length})` : "Resume terminals",
                disabled: !isBulk && (opts.getSuspendedCount?.() ?? 0) === 0,
                onSelect: () => {
                  for (const id of bulkTargets) opts.onResumeProject?.(id);
                },
              },
            ]
          : []),
        ...buildMoveSubmenuItems(controller, bulkTargets, workspaceId, isBulk, () =>
          selection.clear(),
        ),
        ...(isBulk
          ? []
          : buildMoveToFolderItems(controller, project.id, workspaceId, project.folderId)),
        {
          label: "Appearance…",
          onSelect: () => openAppearance(),
        },
        {
          label: project.shortcut
            ? `Shortcut… (Ctrl+Alt+${project.shortcut.toUpperCase()})`
            : "Shortcut…",
          onSelect: () => void runAssignShortcut(),
        },
        ...(opts.onDeleteSelected && selection.has(project.id) && selection.getSelected().size > 1
          ? [
              {
                label: `Delete ${selection.getSelected().size} selected`,
                danger: true,
                onSelect: () => opts.onDeleteSelected?.(),
              },
            ]
          : [
              {
                label: "Delete",
                danger: true,
                onSelect: () => void runDelete(),
              },
            ]),
      ],
    });
  }

  function openInvalidMenu(): void {
    openRowMenu({
      trigger: warn,
      items: [
        {
          label: "Choose new path…",
          onSelect: () => void controller.changeProjectPathInteractive(project.id),
        },
        {
          label: "Retry validation",
          onSelect: () => void controller.retryValidatePath(project.id),
        },
        {
          label: "Delete project",
          danger: true,
          onSelect: () => void runDelete(),
        },
      ],
    });
  }

  async function runDelete(): Promise<void> {
    // When the panel injects `getLiveCount` we surface the real PTY count in
    // the confirm modal. The PTY teardown itself lives in the bootstrap layer
    // (router.dispose) and runs after this resolves true.
    const liveCount = opts.getLiveCount?.() ?? 0;
    if (opts.getLiveCount) {
      await controller.deleteProjectWithLiveCount(project.id, liveCount);
    } else {
      await controller.deleteProject(project.id);
    }
  }

  async function runRename(): Promise<void> {
    const next = await startInlineRename({
      target: name,
      initialValue: project.name,
      placeholder: "Project name",
    });
    if (next && next !== project.name) {
      controller.renameProject(project.id, next);
    }
  }

  async function runCreateWorktree(): Promise<void> {
    const branch = await promptModal({
      title: "Create worktree",
      message: "Branch name for the new worktree, created off the detected base branch.",
      placeholder: "feature/my-branch",
      confirmLabel: "Create",
    });
    if (branch === null) return;
    const trimmed = branch.trim();
    if (!trimmed) {
      showToast("Branch name is required", "error");
      return;
    }
    await controller.createProjectWorktree(project.id, trimmed);
  }

  async function runAssignShortcut(): Promise<void> {
    const next = await promptModal({
      title: "Assign shortcut",
      message: "One letter or digit — activates this project with Ctrl+Alt+<key>. Empty clears.",
      placeholder: "e.g. 1",
      initialValue: project.shortcut ?? "",
      confirmLabel: "Assign",
    });
    if (next === null) return;
    if (!next.trim()) {
      controller.setProjectShortcut(project.id, undefined);
      return;
    }
    const key = normalizeShortcutKey(next);
    if (!key) {
      showToast("Shortcut must be a single letter or digit", "error");
      return;
    }
    controller.setProjectShortcut(project.id, key);
  }

  // Apply initial selected state (survives re-renders since the selection
  // store lives at the panel level), then subscribe for live updates.
  if (selection.has(project.id)) row.classList.add("selected");
  const unsubscribeSelection = selection.on((selected) => {
    row.classList.toggle("selected", selected.has(project.id));
  });

  // F4: appearance picker handle, disposed alongside the row so a popover
  // left open during a re-render is cleaned up.
  let appearancePicker: { dispose(): void } | null = null;
  function openAppearance(): void {
    appearancePicker?.dispose();
    appearancePicker = openAppearancePicker({
      trigger: menuBtn,
      currentColor: project.color,
      onPickColor: (color) => controller.setProjectColor(project.id, color),
    });
  }

  return {
    element: row,
    setLiveCount(n: number): void {
      applyBadge(n);
    },
    setActivity(state: ProjectActivityState): void {
      activityState = state;
      applyActivity();
    },
    setBellPending(pending: boolean): void {
      bellPending = pending;
      applyActivity();
    },
    dispose(): void {
      appearancePicker?.dispose();
      appearancePicker = null;
      unsubscribeSelection();
      for (const off of listeners.splice(0)) off();
      row.remove();
    },
  };
}

export function createShortcutHint(shortcut: string): HTMLElement {
  const hint = document.createElement("kbd");
  hint.className = "ws-shortcut-hint";
  hint.textContent = shortcut.toUpperCase();
  hint.title = `Ctrl+Alt+${shortcut.toUpperCase()}`;
  return hint;
}

function readOrderedProjectIds(listEl: HTMLElement | null): ProjectId[] {
  if (!listEl) return [];
  const out: ProjectId[] = [];
  listEl.querySelectorAll<HTMLElement>(".ws-project-row[data-project-id]").forEach((row) => {
    const id = row.dataset.projectId as ProjectId | undefined;
    if (id) out.push(id);
  });
  return out;
}

function buildMoveSubmenuItems(
  controller: WorkspacesController,
  projectIds: readonly ProjectId[],
  fromWorkspaceId: WorkspaceId,
  isBulk: boolean,
  onAfterBulk: () => void,
): Array<{ label: string; onSelect: () => void; disabled?: boolean }> {
  // A bulk selection can span workspaces, so every workspace is a valid
  // destination; a single project excludes its own workspace as before.
  const targets: Workspace[] = controller
    .getState()
    .workspaces.filter((w) => isBulk || w.id !== fromWorkspaceId);
  if (targets.length === 0) {
    return [{ label: "Move to…", disabled: true, onSelect: () => {} }];
  }
  return targets.map((w) => ({
    label: isBulk ? `Move ${projectIds.length} selected to “${w.name}”` : `Move to “${w.name}”`,
    onSelect: () => {
      if (isBulk) {
        controller.moveProjects(projectIds, w.id, w.projects.length);
        onAfterBulk();
      } else {
        controller.moveProject(projectIds[0], w.id, w.projects.length);
      }
    },
  }));
}

// Same-workspace "move to folder" items, flattened like buildMoveSubmenuItems.
function buildMoveToFolderItems(
  controller: WorkspacesController,
  projectId: ProjectId,
  workspaceId: WorkspaceId,
  currentFolderId: FolderId | undefined,
): Array<{ label: string; onSelect: () => void; disabled?: boolean }> {
  const folders = [
    ...(controller.getState().workspaces.find((w) => w.id === workspaceId)?.folders ?? []),
  ].sort(compareByOrderThenName);
  if (folders.length === 0) return [];
  const items: Array<{ label: string; onSelect: () => void }> = [];
  for (const folder of folders) {
    if (folder.id === currentFolderId) continue;
    items.push({
      label: `Move to folder “${folder.name}”`,
      onSelect: () => controller.moveProjectToFolder(projectId, folder.id),
    });
  }
  if (currentFolderId !== undefined) {
    items.push({
      label: "Move to workspace root",
      onSelect: () => controller.moveProjectToFolder(projectId, undefined),
    });
  }
  return items;
}

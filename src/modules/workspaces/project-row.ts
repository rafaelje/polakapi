import { deterministicColor } from "./appearance-defaults";
import { openAppearancePicker } from "./appearance-picker";
import { openRowMenu } from "./row-menu";
import { startInlineRename } from "./rename-inline";
import type { Project, ProjectId, Workspace, WorkspaceId } from "./types";
import type { WorkspacesController } from "./workspaces-controller";

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
  controller: WorkspacesController;
  /**
   * Resolves the current live count when the row triggers the delete flow —
   * the confirm modal must show the up-to-date number even if the badge has
   * not been touched since the last render.
   */
  getLiveCount?: () => number;
}

export interface ProjectRowHandle {
  element: HTMLElement;
  /** Update the live-terminals badge without re-rendering the row. */
  setLiveCount(n: number): void;
  /**
   * F5: toggles `.has-bell` on the row. The class drives the unread-bell
   * visual (small dot / red glow) defined in styles.css. Cleared by the
   * bootstrap when the project becomes active.
   */
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
  const { project, workspaceId, isActive, controller } = opts;

  const row = document.createElement("div");
  row.className = "ws-project-row";
  if (isActive) row.classList.add("active");
  if (project.pathInvalid) row.classList.add("invalid");
  row.dataset.projectId = project.id;
  row.dataset.workspaceId = workspaceId;
  // F4: same color resolution as workspace-row — explicit override wins,
  // otherwise the deterministic palette so the row still picks up a tint.
  row.dataset.color = project.color ?? deterministicColor(project.id);
  row.setAttribute("draggable", "true");

  const dot = document.createElement("span");
  dot.className = "ws-active-dot";

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
  labelCol.append(nameLine, pathTag);

  const badge = document.createElement("span");
  badge.className = "ws-terminals-badge";

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

  row.append(dot, labelCol, badge, warn, menuBtn);

  const listeners: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
  ): void => {
    el.addEventListener(type, handler);
    listeners.push(() => el.removeEventListener(type, handler));
  };

  on(row, "click", (e) => {
    if (e.defaultPrevented) return;
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

  function openProjectMenu(): void {
    openRowMenu({
      trigger: menuBtn,
      items: [
        { label: "Rename", onSelect: () => void runRename() },
        {
          label: "Change path…",
          onSelect: () => void controller.changeProjectPathInteractive(project.id),
        },
        { label: "Duplicate", onSelect: () => controller.duplicateProject(project.id) },
        ...buildMoveSubmenuItems(controller, project.id, workspaceId),
        {
          label: "Appearance…",
          onSelect: () => openAppearance(),
        },
        {
          label: "Delete",
          danger: true,
          onSelect: () => void runDelete(),
        },
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
    setBellPending(pending: boolean): void {
      row.classList.toggle("has-bell", pending);
    },
    dispose(): void {
      appearancePicker?.dispose();
      appearancePicker = null;
      for (const off of listeners.splice(0)) off();
      row.remove();
    },
  };
}

function buildMoveSubmenuItems(
  controller: WorkspacesController,
  projectId: ProjectId,
  fromWorkspaceId: WorkspaceId,
): Array<{ label: string; onSelect: () => void; disabled?: boolean }> {
  const targets: Workspace[] = controller
    .getState()
    .workspaces.filter((w) => w.id !== fromWorkspaceId);
  if (targets.length === 0) {
    return [{ label: "Move to…", disabled: true, onSelect: () => {} }];
  }
  return targets.map((w) => ({
    label: `Move to “${w.name}”`,
    onSelect: () => controller.moveProject(projectId, w.id, w.projects.length),
  }));
}

import { openRowMenu } from "./row-menu";
import { startInlineRename } from "./rename-inline";
import type { Project, ProjectId, Workspace, WorkspaceId } from "./types";
import type { WorkspacesController } from "./workspaces-controller";

export interface ProjectRowOptions {
  project: Project;
  workspaceId: WorkspaceId;
  isActive: boolean;
  liveTerminalsCount: number;
  controller: WorkspacesController;
}

export interface ProjectRowHandle {
  element: HTMLElement;
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
  badge.textContent = String(opts.liveTerminalsCount);
  if (opts.liveTerminalsCount === 0) badge.classList.add("hidden");

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
          label: "Delete",
          danger: true,
          onSelect: () => void controller.deleteProject(project.id),
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
          onSelect: () => void controller.deleteProject(project.id),
        },
      ],
    });
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

  return {
    element: row,
    dispose(): void {
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

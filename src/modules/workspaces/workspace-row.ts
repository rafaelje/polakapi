import { createProjectRow, type ProjectRowHandle } from "./project-row";
import { openRowMenu } from "./row-menu";
import { startInlineRename } from "./rename-inline";
import type { ProjectId, Workspace } from "./types";
import type { WorkspacesController } from "./workspaces-controller";
import { sortedProjects } from "./workspaces-reducer";

export interface WorkspaceRowOptions {
  workspace: Workspace;
  controller: WorkspacesController;
  /**
   * Resolves the live-terminal count for any project in this workspace at
   * render time. The panel feeds router.getCount via this callback so newly
   * created rows already show the right badge before the next event fires.
   */
  liveCountFor?: (projectId: ProjectId) => number;
}

export interface WorkspaceRowHandle {
  element: HTMLElement;
  /**
   * Update the live-terminal badge for one of this workspace's projects.
   * No-op when the project is not currently rendered under this row.
   */
  setLiveCount(projectId: ProjectId, n: number): void;
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
  if (workspace.collapsed) wrapper.classList.add("collapsed");

  const header = document.createElement("div");
  header.className = "ws-workspace-header";
  header.setAttribute("draggable", "true");

  const chevron = document.createElement("button");
  chevron.type = "button";
  chevron.className = "ws-chevron";
  chevron.title = workspace.collapsed ? "Expand workspace" : "Collapse workspace";
  chevron.textContent = workspace.collapsed ? "▸" : "▾";

  const name = document.createElement("span");
  name.className = "ws-workspace-name";
  name.textContent = workspace.name;

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

  header.append(chevron, name, addBtn, menuBtn);
  wrapper.append(header);

  const projectsList = document.createElement("div");
  projectsList.className = "ws-projects";
  projectsList.dataset.workspaceId = workspace.id;
  wrapper.append(projectsList);

  const projectHandles = new Map<ProjectId, ProjectRowHandle>();
  const activeProjectId = controller.getState().activeProjectId;
  const liveCountFor = opts.liveCountFor;

  for (const project of sortedProjects(workspace)) {
    const initialCount = liveCountFor ? liveCountFor(project.id) : 0;
    const handle = createProjectRow({
      project,
      workspaceId: workspace.id,
      isActive: activeProjectId === project.id,
      liveTerminalsCount: initialCount,
      controller,
      getLiveCount: liveCountFor ? () => liveCountFor(project.id) : undefined,
    });
    projectHandles.set(project.id, handle);
    projectsList.append(handle.element);
  }

  const listeners: Array<() => void> = [];
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

  on(header, "dblclick", (e) => {
    if (e.target === addBtn || e.target === menuBtn) return;
    e.preventDefault();
    void runRename();
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
          label: workspace.collapsed ? "Expand" : "Collapse",
          onSelect: () => controller.toggleCollapsed(workspace.id),
        },
        {
          label: "Sort projects alphabetically",
          onSelect: () => controller.resetAlphabeticalOrder(workspace.id),
        },
        {
          label: "Delete workspace",
          danger: true,
          onSelect: () => void controller.deleteWorkspace(workspace.id),
        },
      ],
    });
  }

  async function runRename(): Promise<void> {
    const next = await startInlineRename({
      target: name,
      initialValue: workspace.name,
      placeholder: "Workspace name",
    });
    if (next && next !== workspace.name) {
      controller.renameWorkspace(workspace.id, next);
    }
  }

  return {
    element: wrapper,
    setLiveCount(projectId: ProjectId, n: number): void {
      projectHandles.get(projectId)?.setLiveCount(n);
    },
    dispose(): void {
      for (const off of listeners.splice(0)) off();
      for (const handle of projectHandles.values()) handle.dispose();
      projectHandles.clear();
      wrapper.remove();
    },
  };
}

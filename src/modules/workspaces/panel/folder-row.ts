import { showToast } from "../../../shared/ui/toast";
import { createProjectRow, type ProjectRowHandle } from "./project-row";
import { filterProjects } from "../project-filter";
import { openRowMenu } from "../forms/row-menu";
import { startInlineRename } from "../forms/rename-inline";
import type { SelectionStore } from "../state/selection";
import type { Folder, Project, ProjectId, Workspace } from "../state/types";
import type { WorkspacesController } from "../state/workspaces-controller";
import { sortedProjectsInFolder } from "../state/workspaces-reducer";

export interface FolderRowOptions {
  folder: Folder;
  workspace: Workspace;
  controller: WorkspacesController;
  liveCountFor?: (projectId: ProjectId) => number;
  getSuspendedCount?: (projectId: ProjectId) => number;
  filterQuery?: string;
  selection: SelectionStore;
  onSuspendProject?: (projectId: ProjectId) => void;
  onResumeProject?: (projectId: ProjectId) => void;
  onDeleteSelected?: () => void;
  isFirst: boolean;
  isLast: boolean;
}

export interface FolderRowHandle {
  element: HTMLElement;
  // Merged by the parent WorkspaceRow into its own flat map.
  projectHandles: ReadonlyMap<ProjectId, ProjectRowHandle>;
  dispose(): void;
}

// Folder header + its own project list, modeled on workspace-row.ts.
export function createFolderRow(opts: FolderRowOptions): FolderRowHandle {
  const { folder, workspace, controller } = opts;

  const wrapper = document.createElement("div");
  wrapper.className = "ws-folder";
  wrapper.dataset.folderId = folder.id;
  wrapper.dataset.workspaceId = workspace.id;
  if (folder.collapsed) wrapper.classList.add("collapsed");

  const header = document.createElement("div");
  header.className = "ws-folder-header";

  const chevron = document.createElement("button");
  chevron.type = "button";
  chevron.className = "ws-chevron";
  chevron.title = folder.collapsed ? "Expand folder" : "Collapse folder";
  chevron.textContent = folder.collapsed ? "▸" : "▾";

  const name = document.createElement("span");
  name.className = "ws-folder-name";
  name.textContent = folder.name;
  if (folder.path) name.title = folder.path;

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "ws-row-add";
  addBtn.title = "Add project to this folder";
  addBtn.textContent = "+";

  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "ws-row-kebab";
  menuBtn.title = "Folder actions";
  menuBtn.textContent = "⋮";

  header.append(chevron, name, addBtn, menuBtn);
  wrapper.append(header);

  const projectsList = document.createElement("div");
  projectsList.className = "ws-folder-projects";
  projectsList.dataset.workspaceId = workspace.id;
  projectsList.dataset.folderId = folder.id;
  wrapper.append(projectsList);

  const projectHandles = new Map<ProjectId, ProjectRowHandle>();
  const activeProjectId = controller.getState().activeProjectId;
  const liveCountFor = opts.liveCountFor;
  const suspendedCountFor = opts.getSuspendedCount;

  const visibleProjects: Project[] = filterProjects(
    opts.filterQuery ?? "",
    workspace,
    sortedProjectsInFolder(workspace, folder.id),
  );

  for (const project of visibleProjects) {
    const initialCount = liveCountFor ? liveCountFor(project.id) : 0;
    const handle = createProjectRow({
      onSuspendProject: opts.onSuspendProject,
      onResumeProject: opts.onResumeProject,
      onDeleteSelected: opts.onDeleteSelected,
      project,
      workspaceId: workspace.id,
      isActive: activeProjectId === project.id,
      liveTerminalsCount: initialCount,
      controller,
      getLiveCount: liveCountFor ? () => liveCountFor(project.id) : undefined,
      getSuspendedCount: suspendedCountFor ? () => suspendedCountFor(project.id) : undefined,
      selection: opts.selection,
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
    controller.toggleFolderCollapsed(workspace.id, folder.id);
  });

  on(header, "dblclick", (e) => {
    if (e.target === addBtn || e.target === menuBtn) return;
    e.preventDefault();
    void runRename();
  });

  on(addBtn, "click", (e) => {
    e.stopPropagation();
    void controller.createProjectInteractive(workspace.id, {
      initialFolderId: folder.id,
      defaultPath: folder.path,
    });
  });

  on(menuBtn, "click", (e) => {
    e.stopPropagation();
    openFolderMenu();
  });

  function openFolderMenu(): void {
    openRowMenu({
      trigger: menuBtn,
      items: [
        { label: "Rename", onSelect: () => void runRename() },
        {
          label: "Add project…",
          onSelect: () =>
            void controller.createProjectInteractive(workspace.id, {
              initialFolderId: folder.id,
              defaultPath: folder.path,
            }),
        },
        {
          label: "Clone repo here…",
          onSelect: () =>
            void controller.cloneRepoInteractive(workspace.id, { folderId: folder.id }),
        },
        {
          label: folder.collapsed ? "Expand" : "Collapse",
          onSelect: () => controller.toggleFolderCollapsed(workspace.id, folder.id),
        },
        {
          label: "Sort projects alphabetically",
          onSelect: () => controller.resetAlphabeticalOrderInFolder(workspace.id, folder.id),
        },
        {
          label: "Move up",
          disabled: opts.isFirst,
          onSelect: () => controller.moveFolderUp(workspace.id, folder.id),
        },
        {
          label: "Move down",
          disabled: opts.isLast,
          onSelect: () => controller.moveFolderDown(workspace.id, folder.id),
        },
        {
          label: "Delete folder",
          danger: true,
          onSelect: () => void controller.deleteFolderInteractive(workspace.id, folder.id),
        },
      ],
    });
  }

  async function runRename(): Promise<void> {
    const next = await startInlineRename({
      target: name,
      initialValue: folder.name,
      placeholder: "Folder name",
    });
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      showToast("Folder name is required", "error");
      return;
    }
    if (trimmed !== folder.name) controller.renameFolder(workspace.id, folder.id, trimmed);
  }

  return {
    element: wrapper,
    projectHandles,
    dispose(): void {
      for (const off of listeners.splice(0)) off();
      for (const handle of projectHandles.values()) handle.dispose();
      projectHandles.clear();
      wrapper.remove();
    },
  };
}

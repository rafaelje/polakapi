import { deterministicColor } from "../appearance-defaults";
import { sortedProjects, sortedWorkspaces } from "../state/workspaces-reducer";
import type { Project, ProjectId, WorkspacesState } from "../state/types";
import type { WorkspacesController } from "../state/workspaces-controller";

export interface RunningEntry {
  project: Project;
  workspaceName: string;
  count: number;
}

export function collectRunningProjects(
  state: WorkspacesState,
  getCount: (projectId: ProjectId) => number,
): RunningEntry[] {
  const entries: RunningEntry[] = [];
  for (const workspace of sortedWorkspaces(state)) {
    for (const project of sortedProjects(workspace)) {
      const count = getCount(project.id);
      if (count > 0) entries.push({ project, workspaceName: workspace.name, count });
    }
  }
  return entries;
}

export interface RunningSectionOptions {
  controller: WorkspacesController;
  getCount: (projectId: ProjectId) => number;
}

export interface RunningSectionHandle {
  element: HTMLElement;
  refresh(): void;
}

export function mountRunningSection(opts: RunningSectionOptions): RunningSectionHandle {
  const { controller, getCount } = opts;

  const section = document.createElement("div");
  section.className = "ws-running hidden";

  const title = document.createElement("div");
  title.className = "ws-running-title";
  title.textContent = "running";

  const list = document.createElement("div");
  list.className = "ws-running-list";

  section.append(title, list);

  const refresh = (): void => {
    const entries = collectRunningProjects(controller.getState(), getCount);
    section.classList.toggle("hidden", entries.length === 0);
    list.replaceChildren();
    const activeId = controller.getState().activeProjectId;
    for (const entry of entries) {
      list.append(createRunningRow(entry, entry.project.id === activeId, controller));
    }
  };

  refresh();
  return { element: section, refresh };
}

function createRunningRow(
  entry: RunningEntry,
  isActive: boolean,
  controller: WorkspacesController,
): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "ws-running-row";
  if (isActive) row.classList.add("active");
  row.dataset.color = entry.project.color ?? deterministicColor(entry.project.id);
  row.title = `${entry.workspaceName} · ${entry.project.path}`;

  const dot = document.createElement("span");
  dot.className = "ws-active-dot";

  const name = document.createElement("span");
  name.className = "ws-running-name";
  name.textContent = entry.project.name;

  const ws = document.createElement("span");
  ws.className = "ws-running-workspace";
  ws.textContent = entry.workspaceName;

  const badge = document.createElement("span");
  badge.className = "ws-terminals-badge live";
  badge.textContent = String(entry.count);

  row.append(dot, name, ws, badge);
  row.addEventListener("click", () => controller.setActiveProject(entry.project.id));
  return row;
}

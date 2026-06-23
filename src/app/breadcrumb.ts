import type { Project, Workspace } from "../modules/workspaces/types";

export interface BreadcrumbOptions {
  host: HTMLElement;
}

export interface BreadcrumbHandle {
  update(workspace: Workspace | null, project: Project | null): void;
  dispose(): void;
}

/**
 * Renders the "Workspace / Project" breadcrumb in the global toolbar. Click
 * handlers are stubbed in F1 — a future iteration will hook them up to the
 * command palette.
 */
export function mountBreadcrumb(opts: BreadcrumbOptions): BreadcrumbHandle {
  const { host } = opts;
  host.classList.add("breadcrumb");
  host.replaceChildren();

  const workspaceEl = document.createElement("span");
  workspaceEl.className = "breadcrumb-segment workspace";

  const separator = document.createElement("span");
  separator.className = "breadcrumb-separator";
  separator.textContent = "/";

  const projectEl = document.createElement("span");
  projectEl.className = "breadcrumb-segment project";

  const placeholder = document.createElement("span");
  placeholder.className = "breadcrumb-placeholder";
  placeholder.textContent = "No project selected";

  const render = (workspace: Workspace | null, project: Project | null): void => {
    host.replaceChildren();
    if (!workspace || !project) {
      host.append(placeholder);
      return;
    }
    workspaceEl.textContent = workspace.name;
    projectEl.textContent = project.name;
    host.append(workspaceEl, separator, projectEl);
  };

  render(null, null);

  return {
    update(workspace, project): void {
      render(workspace, project);
    },
    dispose(): void {
      host.classList.remove("breadcrumb");
      host.replaceChildren();
    },
  };
}

import type { WorkspacesController } from "../state/workspaces-controller";

export interface EmptyStateHandle {
  element: HTMLElement;
  dispose(): void;
}

/**
 * Empty state for the sidebar when there are no workspaces yet. The CTA
 * triggers the interactive workspace-creation flow on the controller.
 */
export function createSidebarEmptyState(controller: WorkspacesController): EmptyStateHandle {
  const wrapper = document.createElement("div");
  wrapper.className = "ws-empty";

  const title = document.createElement("div");
  title.className = "ws-empty-title";
  title.textContent = "No workspaces yet";

  const message = document.createElement("div");
  message.className = "ws-empty-message";
  message.textContent = "Workspaces group projects that share terminals and notes.";

  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "ws-empty-cta";
  cta.textContent = "+ Create workspace";

  const onClick = (): void => {
    void controller.createWorkspaceInteractive();
  };
  cta.addEventListener("click", onClick);

  wrapper.append(title, message, cta);

  return {
    element: wrapper,
    dispose(): void {
      cta.removeEventListener("click", onClick);
      wrapper.remove();
    },
  };
}

/**
 * Empty state shown inside the project pane when no project is active. The
 * orchestrator wires it into the project-pane host.
 */
export function createProjectEmptyState(): EmptyStateHandle {
  const wrapper = document.createElement("div");
  wrapper.className = "ws-empty ws-empty-project";

  const title = document.createElement("div");
  title.className = "ws-empty-title";
  title.textContent = "No project selected";

  const message = document.createElement("div");
  message.className = "ws-empty-message";
  message.textContent = "Choose a project from the sidebar to open its terminals.";

  wrapper.append(title, message);

  return {
    element: wrapper,
    dispose(): void {
      wrapper.remove();
    },
  };
}

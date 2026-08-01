export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/**
 * Lightweight confirmation modal modeled after `promptModal`. Resolves with
 * `true` if the user confirms, `false` otherwise. All listeners are torn
 * down on either path to prevent leaks.
 */
export function confirmModal(opts: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = opts.title;

    const message = document.createElement("div");
    message.className = "modal-message";
    message.textContent = opts.message;

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "modal-btn";
    cancelBtn.textContent = opts.cancelLabel ?? "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = `modal-btn modal-btn-primary${opts.danger ? " modal-btn-danger" : ""}`;
    confirmBtn.textContent = opts.confirmLabel ?? "Confirm";

    actions.append(cancelBtn, confirmBtn);
    dialog.append(title, message, actions);
    backdrop.append(dialog);
    document.body.append(backdrop);

    let settled = false;
    const cleanup = (value: boolean): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (opts.danger) return;
        cleanup(true);
      }
    };

    cancelBtn.addEventListener("click", () => cleanup(false));
    confirmBtn.addEventListener("click", () => cleanup(true));
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) cleanup(false);
    });
    window.addEventListener("keydown", onKey);

    requestAnimationFrame(() => {
      backdrop.classList.add("visible");
      (opts.danger ? cancelBtn : confirmBtn).focus();
    });
  });
}

export function confirmDeleteWorkspace(name: string, projectsCount: number): Promise<boolean> {
  const detail =
    projectsCount === 0
      ? "This workspace has no projects."
      : `It contains ${projectsCount} project${projectsCount === 1 ? "" : "s"} that will also be removed.`;
  return confirmModal({
    title: `Delete workspace "${name}"?`,
    message: `${detail} This action cannot be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
}

export function confirmDeleteProject(name: string, liveTerminals: number): Promise<boolean> {
  const detail =
    liveTerminals > 0
      ? `${liveTerminals} terminal${liveTerminals === 1 ? "" : "s"} attached to this project will be closed.`
      : "This action cannot be undone.";
  return confirmModal({
    title: `Delete project "${name}"?`,
    message: detail,
    confirmLabel: "Delete",
    danger: true,
  });
}

export function confirmDeleteFolder(name: string, projectCount: number): Promise<boolean> {
  const detail =
    projectCount === 0
      ? "This folder is empty."
      : `${projectCount} project${projectCount === 1 ? "" : "s"} will be ungrouped, not deleted.`;
  return confirmModal({
    title: `Delete folder "${name}"?`,
    message: `${detail} The directory on disk is not touched.`,
    confirmLabel: "Delete",
    danger: true,
  });
}

export function confirmDeleteProjects(count: number, liveTerminals: number): Promise<boolean> {
  const detail =
    liveTerminals > 0
      ? `${liveTerminals} attached terminal${liveTerminals === 1 ? "" : "s"} will be closed. This action cannot be undone.`
      : "This action cannot be undone.";
  return confirmModal({
    title: `Delete ${count} projects?`,
    message: detail,
    confirmLabel: "Delete",
    danger: true,
  });
}

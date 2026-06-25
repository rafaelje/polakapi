export interface PromptModalOptions {
  title: string;
  message?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/**
 * In-app prompt modal — replaces the native `window.prompt` which is blocking,
 * unstyled, and disallowed in some webview shells. Resolves with the entered
 * string, or `null` if the user cancels.
 */
export function promptModal(opts: PromptModalOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = opts.title;
    dialog.append(title);

    if (opts.message) {
      const message = document.createElement("div");
      message.className = "modal-message";
      message.textContent = opts.message;
      dialog.append(message);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.className = "modal-input";
    input.placeholder = opts.placeholder ?? "";
    input.value = opts.initialValue ?? "";
    dialog.append(input);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "modal-btn";
    cancelBtn.textContent = opts.cancelLabel ?? "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "modal-btn modal-btn-primary";
    confirmBtn.textContent = opts.confirmLabel ?? "OK";

    actions.append(cancelBtn, confirmBtn);
    dialog.append(actions);
    backdrop.append(dialog);
    document.body.append(backdrop);

    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
    };
    const confirm = (): void => {
      const value = input.value;
      cleanup();
      resolve(value);
    };
    const cancel = (): void => {
      cleanup();
      resolve(null);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      }
    };

    cancelBtn.addEventListener("click", cancel);
    confirmBtn.addEventListener("click", confirm);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) cancel();
    });
    window.addEventListener("keydown", onKey);

    requestAnimationFrame(() => {
      backdrop.classList.add("visible");
      input.focus();
      input.select();
    });
  });
}

export interface ConfirmModalOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, the confirm button uses the danger style. */
  danger?: boolean;
}

/**
 * In-app confirmation modal — replaces `window.confirm` for cases where we want
 * a styled dialog inside the webview (focus mgmt, danger styling, custom labels).
 * Resolves with `true` on confirm and `false` on cancel/Escape/backdrop click.
 */
export function confirmModal(opts: ConfirmModalOptions): Promise<boolean> {
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
    dialog.append(title);

    if (opts.message) {
      const message = document.createElement("div");
      message.className = "modal-message";
      message.textContent = opts.message;
      dialog.append(message);
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "modal-btn";
    cancelBtn.textContent = opts.cancelLabel ?? "Cancelar";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = opts.danger
      ? "modal-btn modal-btn-danger"
      : "modal-btn modal-btn-primary";
    confirmBtn.textContent = opts.confirmLabel ?? "OK";

    actions.append(cancelBtn, confirmBtn);
    dialog.append(actions);
    backdrop.append(dialog);
    document.body.append(backdrop);

    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
    };
    const confirm = (): void => {
      cleanup();
      resolve(true);
    };
    const cancel = (): void => {
      cleanup();
      resolve(false);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        confirm();
      }
    };

    cancelBtn.addEventListener("click", cancel);
    confirmBtn.addEventListener("click", confirm);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) cancel();
    });
    window.addEventListener("keydown", onKey);

    requestAnimationFrame(() => {
      backdrop.classList.add("visible");
      // Focus the confirm action so Enter confirms by default; we override
      // this behaviour for `danger` (move focus to cancel) so destructive
      // actions don't trigger on accidental Enter.
      if (opts.danger) cancelBtn.focus();
      else confirmBtn.focus();
    });
  });
}

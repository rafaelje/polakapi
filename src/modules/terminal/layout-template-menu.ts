import { confirmModal, promptModal } from "../../shared/ui/modal";
import type { LayoutTemplate } from "../workspaces/state/types";
import type { PaneMenuHandle } from "./terminal-pane-menu";

/**
 * Toolbar "Layouts" dropdown: apply/delete saved templates and save the
 * current arrangement under a name. Mirrors `openPaneMenu`'s popover
 * lifecycle: close on outside-click, Escape, scroll, resize.
 */
export interface LayoutTemplateMenuOptions {
  trigger: HTMLElement;
  templates: readonly LayoutTemplate[];
  /** False when the active project has no panes to capture. */
  canSave: boolean;
  onApply(template: LayoutTemplate): void;
  onSaveAs(name: string): void;
  onDelete(templateId: string): void;
}

export function openLayoutTemplateMenu(opts: LayoutTemplateMenuOptions): PaneMenuHandle {
  document.querySelectorAll(".pane-menu-popover").forEach((node) => node.remove());

  const popover = document.createElement("div");
  popover.className = "pane-menu-popover";
  const rect = opts.trigger.getBoundingClientRect();
  popover.style.position = "fixed";
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.left = `${Math.max(8, rect.left)}px`;

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    popover.remove();
    window.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", dispose);
    window.removeEventListener("scroll", dispose, true);
  };
  const onOutside = (e: MouseEvent): void => {
    if (!popover.contains(e.target as Node)) dispose();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") dispose();
  };

  if (opts.templates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "layout-template-empty";
    empty.textContent = "No saved layouts yet";
    popover.append(empty);
  }
  for (const template of opts.templates) {
    popover.append(createTemplateRow(template, opts, dispose));
  }

  const separator = document.createElement("div");
  separator.className = "pane-menu-separator";
  popover.append(separator);

  const saveItem = document.createElement("button");
  saveItem.type = "button";
  saveItem.className = "pane-menu-item";
  saveItem.textContent = "Save current layout…";
  saveItem.disabled = !opts.canSave;
  saveItem.addEventListener("click", () => {
    dispose();
    void promptSaveTemplate(opts);
  });
  popover.append(saveItem);

  document.body.append(popover);
  window.addEventListener("mousedown", onOutside, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", dispose);
  window.addEventListener("scroll", dispose, true);

  return { dispose };
}

function createTemplateRow(
  template: LayoutTemplate,
  opts: LayoutTemplateMenuOptions,
  dispose: () => void,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "layout-template-row";

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "pane-menu-item layout-template-apply";
  applyBtn.textContent = template.name;
  applyBtn.title = `Apply "${template.name}" (${template.specs.length} terminals)`;
  applyBtn.addEventListener("click", () => {
    dispose();
    opts.onApply(template);
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "pane-menu-item layout-template-delete";
  deleteBtn.textContent = "×";
  deleteBtn.title = `Delete "${template.name}"`;
  deleteBtn.addEventListener("click", () => {
    dispose();
    void confirmDeleteTemplate(template, opts);
  });

  row.append(applyBtn, deleteBtn);
  return row;
}

async function promptSaveTemplate(opts: LayoutTemplateMenuOptions): Promise<void> {
  const name = await promptModal({
    title: "Save layout",
    message: "Saves the current terminals (CLIs, arrangement, startup commands) without the path.",
    placeholder: "e.g. 2 Claude + shell",
    confirmLabel: "Save",
  });
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  opts.onSaveAs(trimmed);
}

async function confirmDeleteTemplate(
  template: LayoutTemplate,
  opts: LayoutTemplateMenuOptions,
): Promise<void> {
  const ok = await confirmModal({
    title: "Delete layout",
    message: `Delete "${template.name}"? This cannot be undone.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (ok) opts.onDelete(template.id);
}

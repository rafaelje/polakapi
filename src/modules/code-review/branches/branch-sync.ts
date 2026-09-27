import { requireById } from "../../../shared/dom/dom";
import { fetchBranchRefs, fetchChangesOverview, pullFastForward, switchBranch } from "../api";
import { el } from "../dom";
import type { BranchRefs, CodeReviewTab, PinnedProject } from "../types";
import { branchSwitchGroups, switchBlockReason } from "./branch-switch-model";
import { stringifyError } from "../../../shared/errors";

export interface BranchSyncOptions {
  project: PinnedProject;
  onTabChange(listener: (tab: CodeReviewTab) => void): void;
  onChanged(): Promise<void>;
}

interface SwitcherState {
  refs: BranchRefs;
  blockReason: string | null;
  filter: string;
}

export function mountBranchSync(options: BranchSyncOptions): void {
  const { project } = options;
  const pill = requireById("code-review-branch", HTMLButtonElement);
  const pullButton = requireById("code-review-pull", HTMLButtonElement);
  const status = requireById("code-review-sync-status");
  const popover = el("div", "code-review-switcher");
  popover.hidden = true;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Switch branch");
  pill.after(popover);
  let busy = false;

  const showStatus = (message: string, error = false): void => {
    status.textContent = message;
    status.title = message;
    status.classList.toggle("code-review-error", error);
  };

  const close = (): void => {
    popover.hidden = true;
    pill.setAttribute("aria-expanded", "false");
  };

  const runSwitch = async (ref: string): Promise<void> => {
    if (busy) return;
    busy = true;
    close();
    showStatus(`switching to ${ref}…`);
    try {
      const branch = await switchBranch(project.path, ref);
      showStatus(`switched to ${branch}`);
      await options.onChanged();
    } catch (cause) {
      showStatus(stringifyError(cause), true);
    } finally {
      busy = false;
    }
  };

  const renderSwitcher = (state: SwitcherState): void => {
    const filter = el("input", "code-review-switcher-filter");
    filter.type = "search";
    filter.placeholder = "filter branches";
    filter.value = state.filter;
    filter.addEventListener("input", () => {
      state.filter = filter.value;
      renderList();
    });
    const list = el("div", "code-review-switcher-list");
    list.setAttribute("role", "listbox");
    const renderList = (): void => {
      const groups = branchSwitchGroups(state.refs, state.filter);
      if (groups.length === 0) {
        list.replaceChildren(el("p", "code-review-switcher-note", "No matching branches."));
        return;
      }
      list.replaceChildren(
        ...groups.flatMap((group) => [
          el("div", "code-review-switcher-group", group.label),
          ...group.options.map((option) => {
            const row = el("button", "code-review-switcher-option", option.label);
            row.type = "button";
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", String(option.current));
            row.classList.toggle("is-current", option.current);
            row.disabled = option.current || state.blockReason !== null;
            row.addEventListener("click", () => void runSwitch(option.ref));
            return row;
          }),
        ]),
      );
    };
    renderList();
    const children: HTMLElement[] = [filter];
    if (state.blockReason) {
      children.push(el("p", "code-review-switcher-note code-review-error", state.blockReason));
    }
    popover.replaceChildren(...children, list);
    filter.focus();
  };

  const open = async (): Promise<void> => {
    popover.hidden = false;
    pill.setAttribute("aria-expanded", "true");
    popover.replaceChildren(el("p", "code-review-switcher-note", "Loading branches…"));
    try {
      const [refs, overview] = await Promise.all([
        fetchBranchRefs(project.path),
        fetchChangesOverview(project.path),
      ]);
      if (popover.hidden) return;
      renderSwitcher({ refs, blockReason: switchBlockReason(overview.files), filter: "" });
    } catch (cause) {
      popover.replaceChildren(
        el("p", "code-review-switcher-note code-review-error", stringifyError(cause)),
      );
    }
  };

  pill.addEventListener("click", () => {
    if (popover.hidden) void open();
    else close();
  });
  popover.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
    pill.focus();
  });
  document.addEventListener("mousedown", (event) => {
    const target = event.target as Node;
    if (!popover.hidden && !popover.contains(target) && !pill.contains(target)) close();
  });

  const pull = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    pullButton.disabled = true;
    showStatus("pulling…");
    try {
      showStatus(await pullFastForward(project.path));
      await options.onChanged();
    } catch (cause) {
      showStatus(stringifyError(cause), true);
    } finally {
      busy = false;
      pullButton.disabled = false;
    }
  };

  pullButton.addEventListener("click", () => void pull());
  options.onTabChange((tab) => {
    pullButton.hidden = tab !== "changes";
  });
}

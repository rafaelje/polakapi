import { requireById } from "../../shared/dom/dom";
import type { CodeReviewTab, PinnedProject } from "./types";

export interface CodeReviewLayout {
  list: HTMLElement;
  diff: HTMLElement;
  refreshButton: HTMLButtonElement;
  activeTab(): CodeReviewTab;
  onTabChange(listener: (tab: CodeReviewTab) => void): void;
  setBranch(branch: string | null): void;
}

export function mountCodeReviewLayout(project: PinnedProject): CodeReviewLayout {
  const projectEl = requireById("code-review-project");
  const branchEl = requireById("code-review-branch");
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".code-review-tab"));
  const listeners: Array<(tab: CodeReviewTab) => void> = [];
  let active: CodeReviewTab = "changes";

  projectEl.textContent = project.name;
  projectEl.title = project.path;
  document.title = `/code-review · ${project.name}`;

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const next = tab.dataset.tab === "branch" ? "branch" : "changes";
      if (next === active) return;
      active = next;
      for (const other of tabs) {
        const selected = other === tab;
        other.classList.toggle("is-active", selected);
        other.setAttribute("aria-selected", String(selected));
      }
      listeners.forEach((listener) => listener(active));
    });
  }

  return {
    list: requireById("code-review-list"),
    diff: requireById("code-review-diff"),
    refreshButton: requireById("code-review-refresh", HTMLButtonElement),
    activeTab: () => active,
    onTabChange: (listener) => listeners.push(listener),
    setBranch: (branch) => {
      branchEl.hidden = !branch;
      branchEl.textContent = branch ?? "";
      branchEl.title = branch ? `current branch: ${branch}` : "";
    },
  };
}

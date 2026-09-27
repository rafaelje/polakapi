import { copyToClipboard } from "../diff/diff-copy";
import { el } from "../dom";
import type { ReportTarget } from "./review-run-model";

export interface ReportPathView {
  show(target: ReportTarget): void;
}

export function mountReportPathView(container: HTMLElement): ReportPathView {
  const root = el("div", "code-review-report");
  const header = el("div", "code-review-diff-header");
  const title = el("strong", "code-review-diff-path");
  header.append(title);
  const path = el("code", "code-review-report-path");
  const copy = el("button", "code-review-btn", "Copy path");
  copy.type = "button";
  copy.title = "Copy the report path";
  const copied = el("span", "code-review-diff-copied");
  copied.setAttribute("role", "status");
  const actions = el("div", "code-review-report-actions");
  actions.append(copy, copied);
  const hint = el("p", "code-review-muted", "Open this file in your browser to read the report.");
  root.append(header, path, actions, hint);

  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const onCopied = (message: string): void => {
    copied.textContent = message;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied.textContent = ""), 1800);
  };
  copy.addEventListener("click", () => {
    if (path.textContent) copyToClipboard(path.textContent, "Copied", onCopied);
  });

  return {
    show: (target) => {
      if (root.parentElement !== container) container.replaceChildren(root);
      title.textContent = target.label;
      if (path.textContent !== target.path) {
        path.textContent = target.path;
        copied.textContent = "";
      }
    },
  };
}

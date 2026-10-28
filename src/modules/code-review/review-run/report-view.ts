import { fetchReport } from "../api";
import { copyToClipboard } from "../diff/diff-copy";
import { el } from "../dom";
import { stringifyError } from "../../../shared/errors";
import { renderMermaid } from "./mermaid-render";
import { buildReportDocument } from "./report-document";
import type { ReportFile, ReportTarget } from "./review-run-model";

export interface ReportView {
  show(target: ReportTarget, reload: boolean): void;
}

export function mountReportView(container: HTMLElement, projectPath: string): ReportView {
  const root = el("div", "code-review-report");
  const header = el("div", "code-review-diff-header");
  const title = el("strong", "code-review-diff-path");
  const actions = el("div", "code-review-report-actions");
  const toggle = el("button", "code-review-btn");
  toggle.type = "button";
  const copy = el("button", "code-review-btn", "Copy path");
  copy.type = "button";
  const copied = el("span", "code-review-diff-copied");
  copied.setAttribute("role", "status");
  actions.append(copied, toggle, copy);
  header.append(title, actions);
  const status = el("p", "code-review-muted code-review-report-status");
  status.setAttribute("role", "status");
  const frame = el("iframe", "code-review-report-frame");
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  root.append(header, status, frame);

  let target: ReportTarget | null = null;
  let showingPseudoCode = false;
  let shownPath: string | null = null;
  let shownSource: string | null = null;
  let request = 0;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.hidden = text === "";
    status.classList.toggle("code-review-error", isError);
  };

  const shownFile = (): ReportFile | null =>
    target && (showingPseudoCode && target.pseudoCode ? target.pseudoCode : target);

  const load = async (reload: boolean): Promise<void> => {
    const file = shownFile();
    if (!file) return;
    toggle.hidden = !target?.pseudoCode;
    toggle.textContent = showingPseudoCode ? "Report" : "Pseudo-code";
    copy.title = file.path;
    if (!reload && file.path === shownPath) return;
    const current = ++request;
    if (file.path !== shownPath) setStatus("Loading report…");
    try {
      const source = await fetchReport(projectPath, file.file);
      if (current !== request) return;
      if (file.path === shownPath && source === shownSource) return;
      const doc = await buildReportDocument(source, file.file, renderMermaid);
      if (current !== request) return;
      frame.title = `Report ${file.file}`;
      frame.srcdoc = doc;
      shownPath = file.path;
      shownSource = source;
      setStatus("");
    } catch (error) {
      if (current !== request) return;
      setStatus(`Could not show ${file.file}: ${stringifyError(error)}`, true);
    }
  };

  toggle.addEventListener("click", () => {
    showingPseudoCode = !showingPseudoCode;
    void load(false);
  });
  copy.addEventListener("click", () => {
    const file = shownFile();
    if (!file) return;
    copyToClipboard(file.path, "Copied", (message) => {
      copied.textContent = message;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied.textContent = ""), 1800);
    });
  });

  return {
    show: (next, reload) => {
      if (root.parentElement !== container) {
        container.replaceChildren(root);
        shownPath = null;
      }
      if (next.path !== target?.path) showingPseudoCode = false;
      target = next;
      title.textContent = next.label;
      void load(reload);
    },
  };
}

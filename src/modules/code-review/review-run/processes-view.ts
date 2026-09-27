import { el } from "../dom";
import { processRows, processesMessage, type ProcessesState } from "./review-run-model";

function processItem(label: string, report: string | null, open: string | null): HTMLElement {
  const selected = report !== null && report === open;
  const item = el(report ? "button" : "div", "code-review-file code-review-process");
  item.classList.toggle("is-selected", selected);
  if (item instanceof HTMLButtonElement) item.type = "button";
  if (report) {
    item.dataset.report = report;
    item.title = `Open ${report}`;
    item.setAttribute("aria-selected", String(selected));
  }
  item.append(el("span", "code-review-file-name", label));
  return item;
}

export function renderProcesses(
  container: HTMLElement,
  state: ProcessesState,
  openReport: string | null,
): void {
  const message = processesMessage(state);
  if (message !== null || state.kind !== "loaded") {
    const isError = state.kind === "error";
    container.append(
      el("p", `code-review-empty${isError ? " code-review-error" : ""}`, message ?? ""),
    );
    return;
  }
  const section = el("section", "code-review-group");
  const heading = el("h2", "code-review-group-title");
  heading.title = state.folder;
  heading.append(
    el("span", undefined, state.folder),
    el("span", "code-review-group-count", String(state.processes.length)),
  );
  section.append(heading);
  if (state.index) section.append(processItem("index", state.index, openReport));
  for (const row of processRows(state.processes)) {
    const item = processItem(row.label, row.report, openReport);
    const badge = el("span", "code-review-verdict", row.badge);
    badge.dataset.verdict = row.badge;
    item.append(badge);
    section.append(item);
  }
  container.append(section);
}

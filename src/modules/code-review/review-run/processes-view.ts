import { el } from "../dom";
import { processRows, processesMessage, type ProcessesState } from "./review-run-model";

export function renderProcesses(container: HTMLElement, state: ProcessesState): void {
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
  for (const row of processRows(state.processes)) {
    const item = el("div", "code-review-file code-review-process");
    item.dataset.process = row.key;
    const badge = el("span", "code-review-verdict", row.badge);
    badge.dataset.verdict = row.badge;
    item.append(el("span", "code-review-file-name", row.label), badge);
    section.append(item);
  }
  container.append(section);
}

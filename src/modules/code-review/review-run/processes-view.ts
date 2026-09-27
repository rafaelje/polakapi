import { el } from "../dom";
import { INDEX_KEY, processRows, processesMessage, type ProcessesState } from "./review-run-model";

function processItem(key: string, label: string, selectedKey: string | null): HTMLElement {
  const selected = key === selectedKey;
  const item = el("button", "code-review-file code-review-process");
  item.type = "button";
  item.classList.toggle("is-selected", selected);
  item.dataset.process = key;
  item.title = `Show the path of ${label}`;
  item.setAttribute("aria-selected", String(selected));
  item.append(el("span", "code-review-file-name", label));
  return item;
}

export function renderProcesses(
  container: HTMLElement,
  state: ProcessesState,
  selectedKey: string | null,
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
  if (state.index) section.append(processItem(INDEX_KEY, INDEX_KEY, selectedKey));
  for (const row of processRows(state.processes)) {
    const item = processItem(row.key, row.label, selectedKey);
    const badge = el("span", "code-review-verdict", row.badge);
    badge.dataset.verdict = row.badge;
    item.append(badge);
    section.append(item);
  }
  container.append(section);
}

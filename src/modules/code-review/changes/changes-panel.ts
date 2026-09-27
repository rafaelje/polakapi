import { describeError, fetchChangesOverview } from "../api";
import {
  fileKey,
  groupChanges,
  moveSelection,
  reconcileSelection,
  visibleFileKeys,
  type ChangesGroupView,
} from "../code-review-model";
import { el, renderEmpty } from "../dom";
import type { ChangedFile, PinnedProject } from "../types";
import { renderFileList } from "./file-list";

export interface ChangesPanelOptions {
  project: PinnedProject;
  list: HTMLElement;
  diff: HTMLElement;
  isVisible(): boolean;
  onBranch(branch: string | null): void;
}

export interface ChangesPanel {
  refresh(): Promise<void>;
  move(delta: 1 | -1): void;
  render(): void;
}

export function mountChangesPanel(options: ChangesPanelOptions): ChangesPanel {
  const { project, list, diff } = options;
  let groups: ChangesGroupView[] = [];
  let selectedKey: string | null = null;
  let error: string | null = null;
  let loaded = false;
  let requestId = 0;

  const selectedFile = (): ChangedFile | null =>
    groups.flatMap((group) => group.files).find((file) => fileKey(file) === selectedKey) ?? null;

  const render = (): void => {
    if (error) {
      renderEmpty(list, error, true);
    } else if (!loaded) {
      renderEmpty(list, "Loading changes…");
    } else {
      renderFileList(list, groups, selectedKey);
      list
        .querySelector<HTMLElement>(".code-review-file.is-selected")
        ?.scrollIntoView({ block: "nearest" });
    }
    renderDiffPlaceholder(diff, selectedFile());
  };

  const select = (key: string | null): void => {
    selectedKey = key;
    render();
  };

  list.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".code-review-file");
    if (row?.dataset.key) select(row.dataset.key);
  });

  return {
    render,
    move: (delta) => select(moveSelection(visibleFileKeys(groups), selectedKey, delta)),
    refresh: async () => {
      const current = ++requestId;
      try {
        const overview = await fetchChangesOverview(project.path);
        if (current !== requestId) return;
        groups = groupChanges(overview.files);
        selectedKey = reconcileSelection(visibleFileKeys(groups), selectedKey);
        error = null;
        loaded = true;
        options.onBranch(overview.branch);
      } catch (cause) {
        if (current !== requestId) return;
        error = `Could not read changes: ${describeError(cause)}`;
      }
      if (options.isVisible()) render();
    },
  };
}

function renderDiffPlaceholder(container: HTMLElement, file: ChangedFile | null): void {
  if (!file) {
    renderEmpty(container, "Select a file to see its diff.");
    return;
  }
  const header = el("div", "code-review-diff-header");
  header.append(el("strong", "code-review-diff-path", file.path));
  if (file.originalPath) {
    header.append(el("span", "code-review-muted", `renamed from ${file.originalPath}`));
  }
  header.append(el("span", "code-review-muted", `${file.group} · ${file.status}`));
  container.replaceChildren(
    header,
    el("p", "code-review-empty", "The diff view is not available yet."),
  );
}

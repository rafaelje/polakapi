import { describeError, fetchChangesOverview, stageAll, stagePaths, unstagePaths } from "../api";
import {
  fileKey,
  groupChanges,
  moveSelection,
  reconcileSelection,
  spaceAction,
  visibleFileKeys,
  type ChangesGroupView,
} from "../code-review-model";
import { mountDiffView } from "../diff/diff-view";
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
  toggleStage(): Promise<void>;
  stageAll(): Promise<void>;
}

export function mountChangesPanel(options: ChangesPanelOptions): ChangesPanel {
  const { project, list, diff } = options;
  let groups: ChangesGroupView[] = [];
  let selectedKey: string | null = null;
  let error: string | null = null;
  let actionError: string | null = null;
  let busy = false;
  let loaded = false;
  let requestId = 0;
  let reloadDiff = false;
  const diffView = mountDiffView(diff, project.path, () => options.isVisible());

  const selectedFile = (): ChangedFile | null =>
    groups.flatMap((group) => group.files).find((file) => fileKey(file) === selectedKey) ?? null;

  const render = (): void => {
    if (error) {
      renderEmpty(list, error, true);
    } else if (!loaded) {
      renderEmpty(list, "Loading changes…");
    } else {
      renderFileList(list, groups, selectedKey);
      if (actionError) list.prepend(el("p", "code-review-empty code-review-error", actionError));
      list
        .querySelector<HTMLElement>(".code-review-file.is-selected")
        ?.scrollIntoView({ block: "nearest" });
    }
    diffView.show(selectedFile(), reloadDiff);
    reloadDiff = false;
  };

  const select = (key: string | null): void => {
    selectedKey = key;
    render();
  };

  list.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".code-review-file");
    if (row?.dataset.key) select(row.dataset.key);
  });

  const refresh = async (): Promise<void> => {
    const current = ++requestId;
    try {
      const overview = await fetchChangesOverview(project.path);
      if (current !== requestId) return;
      groups = groupChanges(overview.files);
      selectedKey = reconcileSelection(visibleFileKeys(groups), selectedKey);
      error = null;
      loaded = true;
      reloadDiff = true;
      options.onBranch(overview.branch);
    } catch (cause) {
      if (current !== requestId) return;
      error = `Could not read changes: ${describeError(cause)}`;
    }
    if (options.isVisible()) render();
  };

  const runAction = async (label: string, action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    actionError = null;
    try {
      await action();
    } catch (cause) {
      actionError = `Could not ${label}: ${describeError(cause)}`;
    } finally {
      busy = false;
    }
    await refresh();
  };

  return {
    render,
    refresh: () => {
      actionError = null;
      return refresh();
    },
    move: (delta) => select(moveSelection(visibleFileKeys(groups), selectedKey, delta)),
    toggleStage: async () => {
      const staging = spaceAction(selectedFile());
      if (!staging) return;
      const run = staging.kind === "stage" ? stagePaths : unstagePaths;
      await runAction(staging.kind, () => run(project.path, staging.paths));
    },
    stageAll: () => runAction("stage all", () => stageAll(project.path)),
  };
}

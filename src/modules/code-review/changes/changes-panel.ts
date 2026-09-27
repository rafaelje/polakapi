import { discardChanges, fetchChangesOverview, stageAll, stagePaths, unstagePaths } from "../api";
import {
  changedFileTarget,
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
import { discardPaths, discardStep } from "./discard";
import { renderFileList } from "./file-list";
import { stringifyError } from "../../../shared/errors";

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
  stagedCount(): number;
  isBusy(): boolean;
  runAction(label: string, action: () => Promise<void>): Promise<boolean>;
  onUpdate(listener: () => void): void;
  discard(): Promise<void>;
  disarm(): void;
}

export function mountChangesPanel(options: ChangesPanelOptions): ChangesPanel {
  const { project, list, diff } = options;
  let groups: ChangesGroupView[] = [];
  let selectedKey: string | null = null;
  let armedKey: string | null = null;
  let error: string | null = null;
  let actionError: string | null = null;
  let busy = false;
  let loaded = false;
  let requestId = 0;
  let reloadDiff = false;
  const diffView = mountDiffView(diff, project.path, () => options.isVisible());
  const listeners: Array<() => void> = [];
  const notify = (): void => listeners.forEach((listener) => listener());

  const selectedFile = (): ChangedFile | null =>
    groups.flatMap((group) => group.files).find((file) => fileKey(file) === selectedKey) ?? null;

  const render = (): void => {
    if (error) {
      renderEmpty(list, error, true);
    } else if (!loaded) {
      renderEmpty(list, "Loading changes…");
    } else {
      renderFileList(list, groups, selectedKey, fileKey, armedKey);
      if (actionError) list.prepend(el("p", "code-review-empty code-review-error", actionError));
      list
        .querySelector<HTMLElement>(".code-review-file.is-selected")
        ?.scrollIntoView({ block: "nearest" });
    }
    const file = selectedFile();
    diffView.show(file ? changedFileTarget(file) : null, reloadDiff);
    reloadDiff = false;
  };

  const select = (key: string | null): void => {
    if (key !== selectedKey) armedKey = null;
    selectedKey = key;
    render();
  };

  list.addEventListener("click", (event) => {
    if (!options.isVisible()) return;
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
      if (armedKey !== selectedKey) armedKey = null;
      error = null;
      loaded = true;
      reloadDiff = true;
      options.onBranch(overview.branch);
    } catch (cause) {
      if (current !== requestId) return;
      error = `Could not read changes: ${stringifyError(cause)}`;
    }
    if (options.isVisible()) render();
    notify();
  };

  const runAction = async (label: string, action: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    busy = true;
    actionError = null;
    notify();
    try {
      await action();
    } catch (cause) {
      actionError = `Could not ${label}: ${stringifyError(cause)}`;
    } finally {
      busy = false;
    }
    const succeeded = actionError === null;
    await refresh();
    return succeeded;
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
    stageAll: async () => {
      await runAction("stage all", () => stageAll(project.path));
    },
    stagedCount: () => groups.find((group) => group.group === "staged")?.count ?? 0,
    isBusy: () => busy,
    runAction,
    onUpdate: (listener) => listeners.push(listener),
    discard: async () => {
      if (busy) return;
      const file = selectedFile();
      const step = discardStep(armedKey, selectedKey, "discard");
      armedKey = step.armed;
      render();
      if (!file || step.confirmed === null) return;
      await runAction("discard", () => discardChanges(project.path, discardPaths(file)));
    },
    disarm: () => {
      if (armedKey === null) return;
      armedKey = null;
      if (options.isVisible()) render();
    },
  };
}

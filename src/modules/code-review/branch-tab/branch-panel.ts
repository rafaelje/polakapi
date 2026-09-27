import {
  describeError,
  fetchBranchOverview,
  fetchBranchRefs,
  fetchDefaultBase,
  fetchReviewProcesses,
} from "../api";
import { moveSelection, reconcileSelection } from "../code-review-model";
import { renderFileList } from "../changes/file-list";
import { mountDiffView } from "../diff/diff-view";
import { el } from "../dom";
import { renderProcesses } from "../review-run/processes-view";
import { mountReviewRun, type ReviewAgent } from "../review-run/review-run";
import type { ProcessesState } from "../review-run/review-run-model";
import type { BranchFile, BranchRefs, PinnedProject } from "../types";
import {
  BASE_PLACEHOLDER,
  baseOptionGroups,
  branchFileGroup,
  branchFileKey,
  branchFileTarget,
  listViewFrom,
  resolveBase,
  type BranchFileGroup,
  type BranchListView,
} from "./branch-tab-model";

export interface BranchPanelOptions {
  project: PinnedProject;
  list: HTMLElement;
  diff: HTMLElement;
  basePicker: HTMLSelectElement;
  agent: ReviewAgent;
  isVisible(): boolean;
}

export interface BranchPanel {
  render(): void;
  refresh(): Promise<void>;
  move(delta: 1 | -1): void;
  baseBranch(): string | null;
}

const LIST_VIEWS: ReadonlyArray<[BranchListView, string]> = [
  ["files", "Files"],
  ["processes", "Processes"],
];

export function mountBranchPanel(options: BranchPanelOptions): BranchPanel {
  const { project, list, diff, basePicker } = options;
  let refs: BranchRefs = { current: null, local: [], remote: [] };
  let chosenBase: string | null = null;
  let defaultBase: string | null = null;
  let group: BranchFileGroup | null = null;
  let selectedKey: string | null = null;
  let view: BranchListView = "files";
  let processes: ProcessesState = { kind: "loading" };
  let error: string | null = null;
  let loaded = false;
  let requestId = 0;
  let reloadDiff = false;
  const diffView = mountDiffView(diff, project.path, () => options.isVisible());

  const base = (): string | null => resolveBase(chosenBase, defaultBase);

  const selectedFile = (): BranchFile | null =>
    group?.files.find((file) => branchFileKey(file) === selectedKey) ?? null;

  const renderPicker = (): void => {
    const current = base();
    const placeholder = el("option", undefined, BASE_PLACEHOLDER);
    placeholder.value = "";
    placeholder.disabled = true;
    const groups = baseOptionGroups(refs, current).map((entry) => {
      const optgroup = el("optgroup");
      optgroup.label = entry.label;
      optgroup.append(
        ...entry.options.map((name) => {
          const option = el("option", undefined, name);
          option.value = name;
          return option;
        }),
      );
      return optgroup;
    });
    basePicker.replaceChildren(placeholder, ...groups);
    basePicker.value = current ?? "";
    basePicker.title = current ? `base branch: ${current}` : BASE_PLACEHOLDER;
  };

  const loadProcesses = async (): Promise<void> => {
    try {
      processes = { kind: "loaded", ...(await fetchReviewProcesses(project.path)) };
    } catch (cause) {
      processes = { kind: "error", message: describeError(cause) };
    }
  };

  const reviewRun = mountReviewRun({
    projectPath: project.path,
    agent: options.agent,
    baseBranch: base,
    onStarted: () => {
      view = "processes";
      void loadProcesses().then(() => {
        if (options.isVisible()) render();
      });
    },
  });
  const toggle = el("div", "code-review-list-toggle");
  toggle.setAttribute("role", "tablist");
  const header = el("div", "code-review-branch-header");
  header.append(reviewRun.element, toggle);

  const renderToggle = (): void => {
    toggle.replaceChildren(
      ...LIST_VIEWS.map(([value, label]) => {
        const button = el("button", "code-review-tab", label);
        button.type = "button";
        button.dataset.view = value;
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(value === view));
        button.classList.toggle("is-active", value === view);
        return button;
      }),
    );
  };

  const placeBody = (body: HTMLElement): void => {
    if (list.firstElementChild !== header) {
      list.replaceChildren(header, body);
      return;
    }
    while (list.lastElementChild && list.lastElementChild !== header) {
      list.lastElementChild.remove();
    }
    list.append(body);
  };

  const renderBody = (): HTMLElement => {
    const body = el("div", "code-review-list-body");
    const message = (text: string, isError = false): HTMLElement => {
      body.append(el("p", `code-review-empty${isError ? " code-review-error" : ""}`, text));
      return body;
    };
    if (view === "processes") {
      renderProcesses(body, processes);
      return body;
    }
    if (error) return message(error, true);
    const current = base();
    if (!current && loaded) return message(BASE_PLACEHOLDER);
    if (!loaded || !group) return message("Loading branch…");
    if (group.count === 0) return message(`No commits since the merge base with ${current}.`);
    renderFileList(body, [group], selectedKey, branchFileKey);
    return body;
  };

  const render = (): void => {
    renderPicker();
    renderToggle();
    placeBody(renderBody());
    list
      .querySelector<HTMLElement>(".code-review-file.is-selected")
      ?.scrollIntoView({ block: "nearest" });
    const file = selectedFile();
    const current = base();
    const showDiff = view === "files" && file !== null && current !== null;
    diffView.show(showDiff ? branchFileTarget(file, current) : null, reloadDiff);
    reloadDiff = false;
  };

  const refresh = async (): Promise<void> => {
    const current = ++requestId;
    try {
      const [nextRefs, nextDefault] = await Promise.all([
        fetchBranchRefs(project.path),
        fetchDefaultBase(project.path),
        loadProcesses(),
      ]);
      const nextBase = resolveBase(chosenBase, nextDefault);
      const overview = nextBase ? await fetchBranchOverview(project.path, nextBase) : null;
      if (current !== requestId) return;
      refs = nextRefs;
      defaultBase = nextDefault;
      group = overview ? branchFileGroup(overview.files, overview.base) : null;
      selectedKey = reconcileSelection(group?.keys ?? [], selectedKey);
      error = null;
      reloadDiff = true;
    } catch (cause) {
      if (current !== requestId) return;
      group = null;
      error = `Could not read the branch: ${describeError(cause)}`;
    }
    loaded = true;
    if (options.isVisible()) render();
  };

  list.addEventListener("click", (event) => {
    if (!options.isVisible()) return;
    const target = event.target as HTMLElement;
    const toggle = target.closest<HTMLElement>(".code-review-list-toggle [data-view]");
    if (toggle) {
      view = listViewFrom(toggle.dataset.view);
      render();
      return;
    }
    const row = target.closest<HTMLElement>(".code-review-file");
    if (row?.dataset.key) {
      selectedKey = row.dataset.key;
      render();
    }
  });

  basePicker.addEventListener("change", () => {
    if (!basePicker.value) return;
    chosenBase = basePicker.value;
    basePicker.blur();
    group = null;
    selectedKey = null;
    loaded = false;
    render();
    void refresh();
  });

  return {
    render,
    refresh,
    move: (delta) => {
      if (view !== "files" || !group) return;
      selectedKey = moveSelection(group.keys, selectedKey, delta);
      render();
    },
    baseBranch: base,
  };
}

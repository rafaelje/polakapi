import { modalCloseButton } from "../../shared/ui/modal";
import { showToast } from "../../shared/ui/toast";
import {
  filterSkills,
  skillScopeOptions,
  sortSkills,
  SCOPE_ALL,
  type SkillScopeFilter,
} from "./filter";
import { explainSkill, listSkills, readSkill, writeSkill } from "./skills-service";
import { renderSkillList, renderSkillPreview, updateSkillSelection } from "./skills-modal-list";
import { renderExplainMode, type ExplainState } from "./skills-modal-explain";
import {
  defaultExplainModelFor,
  isExplainCli,
  EXPLAIN_CLIS,
  type ExplainCli,
  type SkillEntry,
} from "./types";

export interface SkillsModalDeps {
  getActiveProjectPath: () => string | null;
  prepareProjectScope: () => Promise<void>;
}

export interface SkillsModalHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

type ModalMode = "list" | "explain" | "editor";

interface EditorState {
  skill: SkillEntry;
  content: string;
  saving: boolean;
  /** True until the file content lands; saving meanwhile would truncate it. */
  loading: boolean;
}

export function mountSkillsModal(deps: SkillsModalDeps): SkillsModalHandle {
  let backdrop: HTMLDivElement | null = null;
  let disposed = false;

  let mode: ModalMode = "list";
  let query = "";
  let scope: SkillScopeFilter = SCOPE_ALL;
  let activeProjectPath: string | null = null;
  let selectedIdx = 0;
  let skills: SkillEntry[] = [];
  let filtered: SkillEntry[] = [];
  let loading = false;
  let explainCli: ExplainCli = "claude";
  let explain: ExplainState | null = null;
  let editor: EditorState | null = null;
  const contentCache = new Map<string, string>();
  let previewToken = 0;
  /** Ticks the explain elapsed counter. Exactly one is ever live — renderBody
   *  clears it before every re-render and only the running explain view starts
   *  a new one. */
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;

  const stopElapsedTimer = (): void => {
    if (elapsedTimer === null) return;
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  };

  const isOpen = (): boolean => backdrop !== null;

  const selectedSkill = (): SkillEntry | null => filtered[selectedIdx] ?? null;

  const rebuildFiltered = (): void => {
    filtered = filterSkills(skills, query, scope);
    if (selectedIdx >= filtered.length) selectedIdx = Math.max(0, filtered.length - 1);
  };

  const loadSkills = async (): Promise<void> => {
    loading = true;
    renderBody();
    activeProjectPath = deps.getActiveProjectPath();
    try {
      await deps.prepareProjectScope();
      skills = sortSkills(await listSkills(), activeProjectPath);
    } catch {
      skills = [];
    }
    loading = false;
    if (!isOpen()) return;
    rebuildFiltered();
    renderBody();
  };

  const loadPreview = (skill: SkillEntry, previewEl: HTMLElement): void => {
    const cached = contentCache.get(skill.path);
    if (cached !== undefined) {
      renderSkillPreview(previewEl, skill, cached);
      return;
    }
    renderSkillPreview(previewEl, skill, null);
    const token = ++previewToken;
    void deps
      .prepareProjectScope()
      .then(() => readSkill(skill.path, skill.projectPath))
      .then((content) => {
        contentCache.set(skill.path, content);
        if (token !== previewToken || !isOpen() || mode !== "list") return;
        if (selectedSkill()?.path !== skill.path) return;
        renderSkillPreview(previewEl, skill, content);
      })
      .catch(() => {
        if (token !== previewToken || !isOpen()) return;
        renderSkillPreview(previewEl, skill, "Could not read this skill file.");
      });
  };

  const paintList = (): void => {
    if (mode !== "list" || !backdrop) return;
    const searchInput = backdrop.querySelector<HTMLInputElement>("[data-skills-search]");
    const listEl = backdrop.querySelector<HTMLElement>("[data-skills-list]");
    const previewEl = backdrop.querySelector<HTMLElement>("[data-skills-preview]");
    const explainBtn = backdrop.querySelector<HTMLButtonElement>("[data-skills-explain]");
    const editBtn = backdrop.querySelector<HTMLButtonElement>("[data-skills-edit]");
    if (!searchInput || !listEl || !previewEl) return;
    if (searchInput.value !== query) searchInput.value = query;
    if (loading) {
      listEl.replaceChildren();
      const busy = document.createElement("div");
      busy.className = "agents-modal-empty";
      busy.textContent = "Scanning skill directories…";
      listEl.append(busy);
      renderSkillPreview(previewEl, null, null);
    } else {
      renderSkillList(
        listEl,
        filtered,
        selectedIdx,
        {
          onHover: (idx) => {
            if (selectedIdx === idx) return;
            selectedIdx = idx;
            updateSkillSelection(listEl, selectedIdx);
            syncPreview();
            syncActionButtons();
          },
          onActivate: (idx) => {
            selectedIdx = idx;
            updateSkillSelection(listEl, selectedIdx);
            syncPreview();
            syncActionButtons();
          },
        },
        activeProjectPath,
      );
      syncPreview();
    }
    syncActionButtons();

    function syncPreview(): void {
      if (!previewEl) return;
      const skill = selectedSkill();
      if (!skill) {
        renderSkillPreview(previewEl, null, null);
        return;
      }
      loadPreview(skill, previewEl);
    }

    function syncActionButtons(): void {
      const hasSelection = selectedSkill() !== null;
      if (explainBtn) explainBtn.disabled = !hasSelection;
      if (editBtn) editBtn.disabled = !hasSelection;
    }
  };

  const beginExplain = (skill: SkillEntry): void => {
    explain = {
      skill,
      cli: explainCli,
      running: false,
      model: defaultExplainModelFor(explainCli),
      text: null,
      error: null,
      startedAt: Date.now(),
    };
    mode = "explain";
    renderBody();
    void runExplain();
  };

  const runExplain = async (): Promise<void> => {
    if (!explain || explain.running) return;
    const current = explain;
    current.running = true;
    current.text = null;
    current.error = null;
    current.startedAt = Date.now();
    renderBody();
    try {
      await deps.prepareProjectScope();
      const result = await explainSkill(
        current.cli,
        current.model,
        current.skill.path,
        current.skill.projectPath,
      );
      current.running = false;
      current.text = result.text || null;
      current.error = result.error ?? (result.text ? null : "The agent returned no output.");
    } catch (error) {
      current.running = false;
      current.error = error instanceof Error ? error.message : String(error);
    }
    if (isOpen() && mode === "explain" && explain === current) renderBody();
  };

  const beginEdit = (skill: SkillEntry): void => {
    const cached = contentCache.get(skill.path);
    editor = { skill, content: cached ?? "", saving: false, loading: cached === undefined };
    mode = "editor";
    renderBody();
    if (cached === undefined) {
      void deps
        .prepareProjectScope()
        .then(() => readSkill(skill.path, skill.projectPath))
        .then((content) => {
          contentCache.set(skill.path, content);
          if (!isOpen() || mode !== "editor" || editor?.skill.path !== skill.path) return;
          editor.content = content;
          editor.loading = false;
          renderBody();
        })
        .catch(() => {
          if (!isOpen() || mode !== "editor") return;
          showToast("Could not load skill content", "error");
          mode = "list";
          renderBody();
        });
    }
  };

  const saveEditor = async (): Promise<void> => {
    if (!editor || editor.saving || editor.loading) return;
    const current = editor;
    current.saving = true;
    renderBody();
    try {
      await deps.prepareProjectScope();
      await writeSkill(current.skill.path, current.content, current.skill.projectPath);
      contentCache.set(current.skill.path, current.content);
      showToast(`Saved "${current.skill.name}"`, "success");
      editor = null;
      mode = "list";
      renderBody();
    } catch {
      current.saving = false;
      if (isOpen() && mode === "editor") renderBody();
    }
  };

  const backToList = (): void => {
    explain = null;
    editor = null;
    mode = "list";
    renderBody();
  };

  const renderBody = (): void => {
    if (!backdrop) return;
    const modal = backdrop.querySelector<HTMLElement>(".agents-modal");
    if (!modal) return;
    stopElapsedTimer();
    modal.replaceChildren();
    if (mode === "list") {
      renderListMode(modal);
      paintList();
    } else if (mode === "explain") {
      const current = explain;
      if (current) {
        renderExplainMode(modal, current, {
          makeCliSelect,
          registerTicker: (paint) => {
            elapsedTimer = setInterval(paint, 1000);
          },
          onRerun: () => void runExplain(),
          onBack: backToList,
          onEdit: () => beginEdit(current.skill),
          onClose: close,
        });
      }
    } else {
      renderEditorMode(modal);
    }
  };

  const makeCliSelect = (onChange: (cli: ExplainCli) => void): HTMLSelectElement => {
    const select = document.createElement("select");
    select.className = "skills-modal-select";
    select.setAttribute("aria-label", "Agent used to explain the skill");
    for (const cli of EXPLAIN_CLIS) {
      const option = document.createElement("option");
      option.value = cli;
      option.textContent = cli;
      if (cli === explainCli) option.selected = true;
      select.append(option);
    }
    select.addEventListener("change", () => {
      if (isExplainCli(select.value)) {
        explainCli = select.value;
        onChange(select.value);
      }
    });
    return select;
  };

  const renderListMode = (modal: HTMLElement): void => {
    const head = document.createElement("div");
    head.className = "agents-modal-head";

    const search = document.createElement("input");
    search.type = "text";
    search.className = "agents-modal-search";
    search.placeholder = "Search skills…";
    search.setAttribute("aria-label", "Search skills");
    search.dataset.skillsSearch = "";
    search.value = query;
    search.addEventListener("input", () => {
      query = search.value;
      rebuildFiltered();
      selectedIdx = 0;
      paintList();
    });
    search.addEventListener("keydown", onListKey);

    const scopeSelect = document.createElement("select");
    scopeSelect.className = "skills-modal-select skills-modal-scope-select";
    scopeSelect.setAttribute("aria-label", "Filter skills by scope");
    scopeSelect.dataset.skillsScope = "";
    for (const option of skillScopeOptions(skills, activeProjectPath)) {
      const el = document.createElement("option");
      el.value = option.value;
      el.textContent = `${option.label} (${option.count})`;
      if (option.value === scope) el.selected = true;
      scopeSelect.append(el);
    }
    scopeSelect.addEventListener("change", () => {
      scope = scopeSelect.value;
      rebuildFiltered();
      selectedIdx = 0;
      paintList();
    });

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "agents-modal-btn";
    refreshBtn.textContent = "refresh";
    refreshBtn.addEventListener("click", () => {
      contentCache.clear();
      void loadSkills();
    });

    head.append(search, scopeSelect, refreshBtn, modalCloseButton(close));

    const body = document.createElement("div");
    body.className = "agents-modal-body";

    const list = document.createElement("div");
    list.className = "agents-modal-list";
    list.setAttribute("role", "listbox");
    list.dataset.skillsList = "";

    const preview = document.createElement("div");
    preview.className = "agents-modal-preview";
    preview.dataset.skillsPreview = "";

    body.append(list, preview);

    const actions = document.createElement("div");
    actions.className = "agents-modal-actions";

    const cliLabel = document.createElement("span");
    cliLabel.className = "skills-modal-cli-label";
    cliLabel.textContent = "explain with";

    const cliSelect = makeCliSelect(() => {});

    const explainBtn = document.createElement("button");
    explainBtn.type = "button";
    explainBtn.className = "agents-modal-btn agents-modal-btn-primary";
    explainBtn.textContent = "explain ⏎";
    explainBtn.dataset.skillsExplain = "";
    explainBtn.addEventListener("click", () => {
      const skill = selectedSkill();
      if (skill) beginExplain(skill);
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "agents-modal-btn";
    editBtn.textContent = "edit";
    editBtn.dataset.skillsEdit = "";
    editBtn.addEventListener("click", () => {
      const skill = selectedSkill();
      if (skill) beginEdit(skill);
    });

    actions.append(cliLabel, cliSelect, explainBtn, editBtn);

    const hint = document.createElement("div");
    hint.className = "agents-modal-hint";
    hint.innerHTML =
      "<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>" +
      "<span><kbd>⏎</kbd> explain</span>" +
      "<span><kbd>⌘E</kbd> edit</span>" +
      "<span><kbd>esc</kbd> close</span>";

    modal.append(head, body, actions, hint);

    requestAnimationFrame(() => search.focus());
  };

  const renderEditorMode = (modal: HTMLElement): void => {
    const current = editor;
    if (!current) return;

    const head = document.createElement("div");
    head.className = "agents-modal-head";
    const title = document.createElement("strong");
    title.className = "agents-modal-editor-title";
    title.textContent = `edit: ${current.skill.name}`;
    const pathLabel = document.createElement("span");
    pathLabel.className = "skills-modal-path";
    pathLabel.textContent = current.skill.path;
    pathLabel.title = current.skill.path;
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "agents-modal-btn";
    cancelBtn.textContent = "cancel";
    cancelBtn.addEventListener("click", backToList);
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "agents-modal-btn agents-modal-btn-primary";
    saveBtn.textContent = current.saving ? "saving…" : "save";
    saveBtn.disabled = current.saving || current.loading;
    saveBtn.addEventListener("click", () => void saveEditor());
    head.append(title, pathLabel, spacer, cancelBtn, saveBtn, modalCloseButton(close));

    const body = document.createElement("div");
    body.className = "agents-modal-editor-body";

    const textarea = document.createElement("textarea");
    textarea.className = "agents-modal-file-content skills-modal-editor-content";
    textarea.value = current.loading ? "Loading…" : current.content;
    textarea.disabled = current.saving || current.loading;
    textarea.addEventListener("input", () => {
      current.content = textarea.value;
    });
    body.append(textarea);

    modal.append(head, body);
    requestAnimationFrame(() => textarea.focus());
  };

  const onListKey = (e: KeyboardEvent): void => {
    if (mode !== "list") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      selectedIdx = (selectedIdx + delta + filtered.length) % filtered.length;
      paintList();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const skill = selectedSkill();
      if (skill) beginExplain(skill);
    }
  };

  const onGlobalKey = (e: KeyboardEvent): void => {
    if (!isOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (mode === "list") close();
      else backToList();
      return;
    }
    if (mode === "list" && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      const skill = selectedSkill();
      if (skill) beginEdit(skill);
    }
  };

  const open = (): void => {
    if (disposed || isOpen()) return;

    mode = "list";
    query = "";
    scope = SCOPE_ALL;
    selectedIdx = 0;
    explain = null;
    editor = null;

    backdrop = document.createElement("div");
    backdrop.className = "agents-modal-backdrop";
    backdrop.addEventListener("mousedown", (e) => {
      // Only dismiss from the list — a stray click while editing or waiting
      // on an explanation used to throw the work away with no confirmation.
      if (e.target === backdrop && mode === "list") close();
    });

    const modal = document.createElement("div");
    modal.className = "agents-modal skills-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Installed skills");
    backdrop.append(modal);
    document.body.append(backdrop);

    window.addEventListener("keydown", onGlobalKey, true);
    void loadSkills();
  };

  const close = (): void => {
    if (!isOpen()) return;
    stopElapsedTimer();
    window.removeEventListener("keydown", onGlobalKey, true);
    backdrop?.remove();
    backdrop = null;
    query = "";
    scope = SCOPE_ALL;
    selectedIdx = 0;
    filtered = [];
    explain = null;
    editor = null;
    mode = "list";
  };

  return {
    open,
    close,
    isOpen,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      close();
    },
  };
}

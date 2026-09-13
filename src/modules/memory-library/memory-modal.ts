import { showToast } from "../../shared/ui/toast";
import { deleteMemory, listMemories, readMemory, writeMemory } from "./memory-service";
import {
  buildRows,
  filterRows,
  projectOptions,
  ALL_PROJECTS,
  type MemoryProjectFilter,
  type MemoryRow,
} from "./types";

// /memory — reviewer for the auto-memory Claude Code keeps per project.
// Groups every ~/.claude/projects/*/memory folder by project (the active
// polakapi project first), previews each file, and lets the user edit or
// delete the facts Claude decided to save on its own.

export interface MemoryModalDeps {
  getActiveProjectPath: () => string | null;
  getKnownProjectPaths: () => string[];
}

export interface MemoryModalHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

type ModalMode = "list" | "editor";

interface EditorState {
  row: MemoryRow;
  content: string;
  saving: boolean;
}

export function mountMemoryModal(deps: MemoryModalDeps): MemoryModalHandle {
  let backdrop: HTMLDivElement | null = null;
  let disposed = false;

  let mode: ModalMode = "list";
  let query = "";
  let project: MemoryProjectFilter = ALL_PROJECTS;
  let selectedIdx = 0;
  let rows: MemoryRow[] = [];
  let filtered: MemoryRow[] = [];
  let loading = false;
  let editor: EditorState | null = null;
  /** Path armed for deletion — the delete button asks for a second click. */
  let confirmingDelete: string | null = null;
  const contentCache = new Map<string, string>();
  let previewToken = 0;

  const isOpen = (): boolean => backdrop !== null;

  const selectedRow = (): MemoryRow | null => filtered[selectedIdx] ?? null;

  const rebuildFiltered = (): void => {
    filtered = filterRows(rows, query, project);
    if (selectedIdx >= filtered.length) selectedIdx = Math.max(0, filtered.length - 1);
  };

  const loadMemories = async (): Promise<void> => {
    loading = true;
    renderBody();
    try {
      const groups = await listMemories();
      rows = buildRows(groups, deps.getKnownProjectPaths(), deps.getActiveProjectPath());
    } catch {
      rows = [];
    }
    // A refresh can drop the project the filter pointed at.
    if (project !== ALL_PROJECTS && !rows.some((row) => row.dirName === project)) {
      project = ALL_PROJECTS;
    }
    loading = false;
    if (!isOpen()) return;
    rebuildFiltered();
    renderBody();
  };

  const loadPreview = (row: MemoryRow, previewEl: HTMLElement): void => {
    const cached = contentCache.get(row.file.path);
    if (cached !== undefined) {
      renderPreview(previewEl, row, cached);
      return;
    }
    renderPreview(previewEl, row, null);
    const token = ++previewToken;
    void readMemory(row.file.path)
      .then((content) => {
        contentCache.set(row.file.path, content);
        if (token !== previewToken || !isOpen() || mode !== "list") return;
        if (selectedRow()?.file.path !== row.file.path) return;
        renderPreview(previewEl, row, content);
      })
      .catch(() => {
        if (token !== previewToken || !isOpen()) return;
        renderPreview(previewEl, row, "Could not read this memory file.");
      });
  };

  const paintList = (): void => {
    if (mode !== "list" || !backdrop) return;
    const searchInput = backdrop.querySelector<HTMLInputElement>("[data-memory-search]");
    const listEl = backdrop.querySelector<HTMLElement>("[data-memory-list]");
    const previewEl = backdrop.querySelector<HTMLElement>("[data-memory-preview]");
    const editBtn = backdrop.querySelector<HTMLButtonElement>("[data-memory-edit]");
    const deleteBtn = backdrop.querySelector<HTMLButtonElement>("[data-memory-delete]");
    if (!searchInput || !listEl || !previewEl) return;
    if (searchInput.value !== query) searchInput.value = query;
    if (loading) {
      listEl.replaceChildren();
      const busy = document.createElement("div");
      busy.className = "agents-modal-empty";
      busy.textContent = "Scanning Claude memory directories…";
      listEl.append(busy);
      renderPreview(previewEl, null, null);
    } else {
      renderRowList(listEl, filtered, selectedIdx, (idx) => {
        selectedIdx = idx;
        confirmingDelete = null;
        updateSelection(listEl, selectedIdx);
        syncPreview();
        syncActions();
      });
      syncPreview();
    }
    syncActions();

    function syncPreview(): void {
      if (!previewEl) return;
      const row = selectedRow();
      if (!row) {
        renderPreview(previewEl, null, null);
        return;
      }
      loadPreview(row, previewEl);
    }

    function syncActions(): void {
      const row = selectedRow();
      if (editBtn) editBtn.disabled = row === null;
      if (deleteBtn) {
        deleteBtn.disabled = row === null || row.file.isIndex;
        const armed = row !== null && confirmingDelete === row.file.path;
        deleteBtn.textContent = armed ? "click again to delete" : "delete";
        deleteBtn.classList.toggle("memory-modal-btn-armed", armed);
      }
    }
  };

  const beginEdit = (row: MemoryRow): void => {
    const cached = contentCache.get(row.file.path);
    editor = { row, content: cached ?? "", saving: false };
    mode = "editor";
    renderBody();
    if (cached === undefined) {
      void readMemory(row.file.path)
        .then((content) => {
          contentCache.set(row.file.path, content);
          if (!isOpen() || mode !== "editor" || editor?.row.file.path !== row.file.path) return;
          editor.content = content;
          renderBody();
        })
        .catch(() => {
          if (!isOpen() || mode !== "editor") return;
          showToast("Could not load memory content", "error");
          mode = "list";
          renderBody();
        });
    }
  };

  const saveEditor = async (): Promise<void> => {
    if (!editor || editor.saving) return;
    const current = editor;
    current.saving = true;
    renderBody();
    try {
      await writeMemory(current.row.file.path, current.content);
      contentCache.set(current.row.file.path, current.content);
      showToast(`Saved "${current.row.file.name}"`, "success");
      editor = null;
      mode = "list";
      void loadMemories();
    } catch {
      current.saving = false;
      if (isOpen() && mode === "editor") renderBody();
    }
  };

  const requestDelete = (row: MemoryRow): void => {
    if (confirmingDelete !== row.file.path) {
      confirmingDelete = row.file.path;
      paintList();
      return;
    }
    confirmingDelete = null;
    void (async () => {
      try {
        await deleteMemory(row.file.path);
        contentCache.delete(row.file.path);
        showToast(`Deleted "${row.file.name}" (index entry pruned)`, "success");
        void loadMemories();
      } catch {
        // invoke() already surfaced the error toast
      }
    })();
  };

  const backToList = (): void => {
    editor = null;
    mode = "list";
    renderBody();
  };

  const renderBody = (): void => {
    if (!backdrop) return;
    const modal = backdrop.querySelector<HTMLElement>(".agents-modal");
    if (!modal) return;
    modal.replaceChildren();
    if (mode === "list") {
      renderListMode(modal);
      paintList();
    } else {
      renderEditorMode(modal);
    }
  };

  const renderListMode = (modal: HTMLElement): void => {
    const head = document.createElement("div");
    head.className = "agents-modal-head";

    const search = document.createElement("input");
    search.type = "text";
    search.className = "agents-modal-search";
    search.placeholder = "Search memories…";
    search.setAttribute("aria-label", "Search memories");
    search.dataset.memorySearch = "";
    search.value = query;
    search.addEventListener("input", () => {
      query = search.value;
      rebuildFiltered();
      selectedIdx = 0;
      confirmingDelete = null;
      paintList();
    });
    search.addEventListener("keydown", onListKey);

    const projectSelect = document.createElement("select");
    projectSelect.className = "skills-modal-select memory-modal-project-select";
    projectSelect.setAttribute("aria-label", "Filter memories by project");
    projectSelect.dataset.memoryProject = "";
    for (const option of projectOptions(rows)) {
      const el = document.createElement("option");
      el.value = option.value;
      el.textContent = `${option.label} (${option.count})`;
      if (option.value === project) el.selected = true;
      projectSelect.append(el);
    }
    projectSelect.addEventListener("change", () => {
      project = projectSelect.value;
      rebuildFiltered();
      selectedIdx = 0;
      confirmingDelete = null;
      paintList();
    });

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "agents-modal-btn";
    refreshBtn.textContent = "refresh";
    refreshBtn.addEventListener("click", () => {
      contentCache.clear();
      void loadMemories();
    });

    head.append(search, projectSelect, refreshBtn);

    const body = document.createElement("div");
    body.className = "agents-modal-body";

    const list = document.createElement("div");
    list.className = "agents-modal-list";
    list.setAttribute("role", "listbox");
    list.dataset.memoryList = "";

    const preview = document.createElement("div");
    preview.className = "agents-modal-preview";
    preview.dataset.memoryPreview = "";

    body.append(list, preview);

    const actions = document.createElement("div");
    actions.className = "agents-modal-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "agents-modal-btn agents-modal-btn-primary";
    editBtn.textContent = "edit ⏎";
    editBtn.dataset.memoryEdit = "";
    editBtn.addEventListener("click", () => {
      const row = selectedRow();
      if (row) beginEdit(row);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "agents-modal-btn memory-modal-btn-danger";
    deleteBtn.textContent = "delete";
    deleteBtn.dataset.memoryDelete = "";
    deleteBtn.addEventListener("click", () => {
      const row = selectedRow();
      if (row && !row.file.isIndex) requestDelete(row);
    });

    actions.append(editBtn, deleteBtn);

    const hint = document.createElement("div");
    hint.className = "agents-modal-hint";
    hint.innerHTML =
      "<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>" +
      "<span><kbd>⏎</kbd> edit</span>" +
      "<span><kbd>⌫</kbd> delete</span>" +
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
    title.textContent = `edit: ${current.row.file.name}`;
    const pathLabel = document.createElement("span");
    pathLabel.className = "skills-modal-path";
    pathLabel.textContent = current.row.file.path;
    pathLabel.title = current.row.file.path;
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
    saveBtn.disabled = current.saving;
    saveBtn.addEventListener("click", () => void saveEditor());
    head.append(title, pathLabel, spacer, cancelBtn, saveBtn);

    const body = document.createElement("div");
    body.className = "agents-modal-editor-body";

    const textarea = document.createElement("textarea");
    textarea.className = "agents-modal-file-content memory-modal-editor-content";
    textarea.value = current.content;
    textarea.disabled = current.saving;
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
      const row = selectedRow();
      if (row) beginEdit(row);
      return;
    }
    if (e.key === "Backspace" && query === "") {
      e.preventDefault();
      const row = selectedRow();
      if (row && !row.file.isIndex) requestDelete(row);
    }
  };

  const onGlobalKey = (e: KeyboardEvent): void => {
    if (!isOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (mode === "list") close();
      else backToList();
    }
  };

  const open = (): void => {
    if (disposed || isOpen()) return;

    mode = "list";
    query = "";
    project = ALL_PROJECTS;
    selectedIdx = 0;
    editor = null;

    backdrop = document.createElement("div");
    backdrop.className = "agents-modal-backdrop";
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close();
    });

    const modal = document.createElement("div");
    modal.className = "agents-modal memory-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Claude memory reviewer");
    backdrop.append(modal);
    document.body.append(backdrop);

    window.addEventListener("keydown", onGlobalKey, true);
    void loadMemories();
  };

  const close = (): void => {
    if (!isOpen()) return;
    window.removeEventListener("keydown", onGlobalKey, true);
    backdrop?.remove();
    backdrop = null;
    query = "";
    project = ALL_PROJECTS;
    selectedIdx = 0;
    filtered = [];
    editor = null;
    confirmingDelete = null;
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

function renderRowList(
  listEl: HTMLElement,
  rows: readonly MemoryRow[],
  selectedIdx: number,
  onSelect: (idx: number) => void,
): void {
  listEl.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "agents-modal-empty";
    empty.textContent = "No Claude memories found under ~/.claude/projects.";
    listEl.append(empty);
    return;
  }
  let lastProject: string | null = null;
  rows.forEach((row, idx) => {
    if (row.projectLabel !== lastProject) {
      lastProject = row.projectLabel;
      const header = document.createElement("div");
      header.className = "memory-modal-group";
      const name = document.createElement("span");
      name.className = "memory-modal-group-name";
      name.textContent = row.projectLabel;
      name.title = row.projectLabel;
      header.append(name);
      if (row.isActiveProject) {
        const badge = document.createElement("span");
        badge.className = "memory-modal-active-badge";
        badge.textContent = "current repo";
        header.append(badge);
      }
      listEl.append(header);
    }
    const rowEl = document.createElement("div");
    rowEl.className = "agents-modal-row";
    rowEl.setAttribute("role", "option");
    if (idx === selectedIdx) rowEl.setAttribute("aria-selected", "true");
    rowEl.dataset.idx = String(idx);

    const head = document.createElement("div");
    head.className = "skills-modal-row-head";

    const name = document.createElement("span");
    name.className = "agents-modal-row-name";
    name.textContent = row.file.name;

    head.append(name);
    if (row.file.isIndex) {
      const badge = document.createElement("span");
      badge.className = "memory-modal-index-badge";
      badge.textContent = "main index";
      head.append(badge);
    }

    const desc = document.createElement("div");
    desc.className = "agents-modal-row-desc";
    desc.textContent = row.file.description || " ";

    rowEl.append(head, desc);
    rowEl.addEventListener("mouseenter", () => {
      if (idx !== selectedIdx) onSelect(idx);
    });
    rowEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSelect(idx);
    });
    listEl.append(rowEl);
  });
}

function updateSelection(listEl: HTMLElement, selectedIdx: number): void {
  const rowEls = listEl.querySelectorAll<HTMLElement>(".agents-modal-row");
  rowEls.forEach((rowEl) => {
    if (rowEl.dataset.idx === String(selectedIdx)) {
      rowEl.setAttribute("aria-selected", "true");
      rowEl.scrollIntoView({ block: "nearest" });
    } else {
      rowEl.removeAttribute("aria-selected");
    }
  });
}

function renderPreview(
  previewEl: HTMLElement,
  row: MemoryRow | null,
  content: string | null,
): void {
  previewEl.replaceChildren();
  if (!row) {
    const empty = document.createElement("div");
    empty.className = "agents-modal-preview-empty";
    empty.textContent = "Select a memory to preview";
    previewEl.append(empty);
    return;
  }
  const chips = document.createElement("div");
  chips.className = "agents-modal-chips";
  const projectChip = document.createElement("span");
  projectChip.className = "agents-modal-chip";
  projectChip.textContent = row.projectLabel;
  projectChip.title = row.file.path;
  chips.append(projectChip);

  const body = document.createElement("pre");
  body.className = "agents-modal-preview-body";
  body.textContent = content ?? "Loading…";

  previewEl.append(chips, body);
}

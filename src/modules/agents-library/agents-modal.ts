import { confirmModal } from "../../shared/ui/modal";
import { showToast } from "../../shared/ui/toast";
import { ptyWrite } from "../terminal/pty-client";
import { DuplicateAgentNameError, type AgentsController } from "./agents-controller";
import { renderAgentList, renderAgentPreview, updateAgentSelection } from "./agents-modal-list";
import { bracketedPaste, composeAgentText } from "./compose";
import { filterAgents } from "./filter";
import { resolveInsertTarget, type InsertTarget, type TerminalRouterLookup } from "./insert-target";
import type { AgentDef, AgentFileInput } from "./types";

export interface AgentsModalOptions {
  controller: AgentsController;
  router: TerminalRouterLookup;
  /** Called after a successful insert so the app can refocus the terminal. */
  onAfterInsert?: (target: InsertTarget) => void;
}

export interface AgentsModalHandle {
  open(): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

type ModalMode = "list" | "editor";

interface EditorDraft {
  agentId: string | null; // null = new
  name: string;
  description: string;
  files: AgentFileInput[];
  nameError: string | null;
  contentError: string | null;
}

function draftFromAgent(agent: AgentDef | null): EditorDraft {
  if (!agent) {
    return {
      agentId: null,
      name: "",
      description: "",
      files: [{ title: "instructions.md", content: "" }],
      nameError: null,
      contentError: null,
    };
  }
  return {
    agentId: agent.id,
    name: agent.name,
    description: agent.description,
    files: agent.files.map((f) => ({ title: f.title, content: f.content })),
    nameError: null,
    contentError: null,
  };
}

export function mountAgentsModal(opts: AgentsModalOptions): AgentsModalHandle {
  const { controller, router, onAfterInsert } = opts;

  let backdrop: HTMLDivElement | null = null;
  let unsubscribeState: (() => void) | null = null;
  let disposed = false;

  let mode: ModalMode = "list";
  let query = "";
  let selectedIdx = 0;
  let filtered: AgentDef[] = [];
  let target: InsertTarget | null = null;
  let draft: EditorDraft = draftFromAgent(null);

  const isOpen = (): boolean => backdrop !== null;

  // -----------------------------------------------------------------------
  // Insert
  // -----------------------------------------------------------------------

  const doInsert = (agent: AgentDef): void => {
    // Re-resolve at insert time — the badge captured at open could be stale
    // if the user changed focus (Cmd+[/]/1..9) while the modal was up.
    const current = resolveInsertTarget(router);
    if (!current) {
      showToast("Open a terminal to insert into", "warning");
      return;
    }
    const payload = bracketedPaste(composeAgentText(agent));
    void ptyWrite(current.ptyId, payload)
      .then(() => {
        showToast(`Inserted "${agent.name}" into ${current.paneLabel}`, "success");
        close();
        onAfterInsert?.(current);
      })
      .catch((error) => {
        console.error("Failed to insert agent into pane", error);
        showToast(`Could not insert into ${current.paneLabel}`, "error");
      });
  };

  // -----------------------------------------------------------------------
  // List mode
  // -----------------------------------------------------------------------

  const rebuildFiltered = (): void => {
    filtered = filterAgents(controller.getState().agents, query);
    if (selectedIdx >= filtered.length) selectedIdx = Math.max(0, filtered.length - 1);
  };

  const paintList = (): void => {
    if (mode !== "list" || !backdrop) return;
    const searchInput = backdrop.querySelector<HTMLInputElement>("[data-agents-search]");
    const listEl = backdrop.querySelector<HTMLElement>("[data-agents-list]");
    const previewEl = backdrop.querySelector<HTMLElement>("[data-agents-preview]");
    const badgeEl = backdrop.querySelector<HTMLElement>("[data-agents-target]");
    const editBtn = backdrop.querySelector<HTMLButtonElement>("[data-agents-edit]");
    const deleteBtn = backdrop.querySelector<HTMLButtonElement>("[data-agents-delete]");
    const insertBtn = backdrop.querySelector<HTMLButtonElement>("[data-agents-insert]");
    if (!searchInput || !listEl || !previewEl || !badgeEl) return;
    if (searchInput.value !== query) searchInput.value = query;
    renderAgentList(listEl, filtered, selectedIdx, {
      onHover: (idx) => {
        if (selectedIdx === idx) return;
        selectedIdx = idx;
        updateAgentSelection(listEl, selectedIdx);
        renderAgentPreview(previewEl, filtered[selectedIdx] ?? null);
        syncActionButtons();
      },
      onActivate: (idx) => {
        selectedIdx = idx;
        activateSelected();
      },
    });
    renderAgentPreview(previewEl, filtered[selectedIdx] ?? null);
    // Live-update the target badge — resolving at paint captures pane focus
    // changes made while the modal is open.
    target = resolveInsertTarget(router);
    if (target) {
      badgeEl.textContent = `→ ${target.paneLabel}`;
      badgeEl.classList.remove("agents-modal-badge-off");
    } else {
      badgeEl.textContent = "no live pane";
      badgeEl.classList.add("agents-modal-badge-off");
    }
    syncActionButtons();

    function syncActionButtons(): void {
      const hasSelection = filtered.length > 0 && selectedIdx >= 0;
      const hasTarget = target !== null;
      if (editBtn) editBtn.disabled = !hasSelection;
      if (deleteBtn) deleteBtn.disabled = !hasSelection;
      if (insertBtn) insertBtn.disabled = !hasSelection || !hasTarget;
    }
  };

  const activateSelected = (): void => {
    const agent = filtered[selectedIdx];
    if (!agent) return;
    doInsert(agent);
  };

  const beginEdit = (agent: AgentDef): void => {
    draft = draftFromAgent(agent);
    mode = "editor";
    renderBody();
  };

  const beginCreate = (): void => {
    draft = draftFromAgent(null);
    mode = "editor";
    renderBody();
  };

  const requestDelete = async (agent: AgentDef): Promise<void> => {
    const ok = await confirmModal({
      title: "Delete agent",
      message: `Delete "${agent.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    controller.remove(agent.id);
    showToast(`Deleted "${agent.name}"`, "info");
  };

  // -----------------------------------------------------------------------
  // Editor mode
  // -----------------------------------------------------------------------

  const commitDraft = (): void => {
    draft.nameError = null;
    draft.contentError = null;
    const trimmedName = draft.name.trim();
    if (!trimmedName) {
      draft.nameError = "Name is required";
      renderBody();
      return;
    }
    if (draft.files.every((f) => f.content.trim() === "")) {
      draft.contentError = "At least one file must have content";
      renderBody();
      return;
    }
    try {
      let saved: AgentDef;
      if (draft.agentId) {
        saved = controller.update(draft.agentId, {
          name: trimmedName,
          description: draft.description,
          files: draft.files,
        });
      } else {
        saved = controller.create({
          name: trimmedName,
          description: draft.description,
          files: draft.files,
        });
      }
      mode = "list";
      query = "";
      rebuildFiltered();
      selectedIdx = Math.max(
        0,
        filtered.findIndex((a) => a.id === saved.id),
      );
      renderBody();
    } catch (error) {
      if (error instanceof DuplicateAgentNameError) {
        draft.nameError = "An agent with this name already exists";
        renderBody();
        return;
      }
      console.error("Failed to save agent", error);
      showToast("Could not save agent", "error");
    }
  };

  const cancelEditor = (): void => {
    mode = "list";
    renderBody();
  };

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  const renderBody = (): void => {
    if (!backdrop) return;
    const modal = backdrop.querySelector<HTMLElement>(".agents-modal");
    if (!modal) return;
    modal.replaceChildren();
    if (mode === "list") {
      renderListMode(modal);
      rebuildFiltered();
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
    search.placeholder = "Search agents…";
    search.setAttribute("aria-label", "Search agents");
    search.dataset.agentsSearch = "";
    search.value = query;
    search.addEventListener("input", () => {
      query = search.value;
      rebuildFiltered();
      selectedIdx = 0;
      paintList();
    });
    search.addEventListener("keydown", onListKey);

    const badge = document.createElement("span");
    badge.className = "agents-modal-badge";
    badge.dataset.agentsTarget = "";

    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "agents-modal-btn agents-modal-btn-primary";
    newBtn.textContent = "+ new agent";
    newBtn.addEventListener("click", () => beginCreate());

    head.append(search, badge, newBtn);

    const body = document.createElement("div");
    body.className = "agents-modal-body";

    const list = document.createElement("div");
    list.className = "agents-modal-list";
    list.setAttribute("role", "listbox");
    list.dataset.agentsList = "";

    const preview = document.createElement("div");
    preview.className = "agents-modal-preview";
    preview.dataset.agentsPreview = "";

    body.append(list, preview);

    const actions = document.createElement("div");
    actions.className = "agents-modal-actions";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "agents-modal-btn agents-modal-btn-danger";
    deleteBtn.textContent = "delete";
    deleteBtn.dataset.agentsDelete = "";
    deleteBtn.addEventListener("click", () => {
      const agent = filtered[selectedIdx];
      if (agent) void requestDelete(agent);
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "agents-modal-btn";
    editBtn.textContent = "edit";
    editBtn.dataset.agentsEdit = "";
    editBtn.addEventListener("click", () => {
      const agent = filtered[selectedIdx];
      if (agent) beginEdit(agent);
    });

    const insertBtn = document.createElement("button");
    insertBtn.type = "button";
    insertBtn.className = "agents-modal-btn agents-modal-btn-primary";
    insertBtn.textContent = "insert ⏎";
    insertBtn.dataset.agentsInsert = "";
    insertBtn.addEventListener("click", () => activateSelected());

    actions.append(deleteBtn, editBtn, insertBtn);

    const hint = document.createElement("div");
    hint.className = "agents-modal-hint";
    hint.innerHTML =
      "<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>" +
      "<span><kbd>⏎</kbd> insert</span>" +
      "<span><kbd>⌘N</kbd> new</span>" +
      "<span><kbd>esc</kbd> close</span>";

    modal.append(head, body, actions, hint);

    requestAnimationFrame(() => search.focus());
  };

  const renderEditorMode = (modal: HTMLElement): void => {
    const head = document.createElement("div");
    head.className = "agents-modal-head";
    const title = document.createElement("strong");
    title.className = "agents-modal-editor-title";
    title.textContent = draft.agentId ? "edit agent" : "new agent";
    const spacer = document.createElement("span");
    spacer.style.flex = "1";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "agents-modal-btn";
    cancelBtn.textContent = "cancel";
    cancelBtn.addEventListener("click", cancelEditor);
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "agents-modal-btn agents-modal-btn-primary";
    saveBtn.textContent = "save";
    saveBtn.addEventListener("click", commitDraft);
    head.append(title, spacer, cancelBtn, saveBtn);

    const body = document.createElement("div");
    body.className = "agents-modal-editor-body";

    body.append(
      makeField(
        "name",
        (input) => {
          input.value = draft.name;
          input.addEventListener("input", () => {
            draft.name = input.value;
          });
        },
        draft.nameError,
      ),
      makeField(
        "description",
        (input) => {
          input.value = draft.description;
          input.addEventListener("input", () => {
            draft.description = input.value;
          });
        },
        null,
      ),
    );

    const filesLabel = document.createElement("div");
    filesLabel.className = "agents-modal-editor-field-label";
    filesLabel.textContent = "files (1..n)";
    body.append(filesLabel);

    if (draft.contentError) {
      const err = document.createElement("div");
      err.className = "agents-modal-editor-error";
      err.textContent = draft.contentError;
      body.append(err);
    }

    draft.files.forEach((file, idx) => body.append(makeFileBlock(file, idx)));

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "agents-modal-btn agents-modal-add-file";
    addBtn.textContent = "+ add file";
    addBtn.addEventListener("click", () => {
      draft.files.push({ title: `file-${draft.files.length + 1}.md`, content: "" });
      renderBody();
    });
    body.append(addBtn);

    modal.append(head, body);
  };

  const makeField = (
    label: string,
    hook: (input: HTMLInputElement) => void,
    error: string | null,
  ): HTMLElement => {
    const wrap = document.createElement("div");
    wrap.className = "agents-modal-editor-field";
    const lbl = document.createElement("label");
    lbl.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    wrap.append(lbl, input);
    if (error) {
      const err = document.createElement("div");
      err.className = "agents-modal-editor-error";
      err.textContent = error;
      wrap.append(err);
    }
    hook(input);
    return wrap;
  };

  const makeFileBlock = (file: AgentFileInput, idx: number): HTMLElement => {
    const wrap = document.createElement("div");
    wrap.className = "agents-modal-file";

    const head = document.createElement("div");
    head.className = "agents-modal-file-head";

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "agents-modal-file-title";
    titleInput.value = file.title;
    titleInput.addEventListener("input", () => {
      draft.files[idx].title = titleInput.value;
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "agents-modal-btn agents-modal-btn-danger";
    removeBtn.textContent = "remove";
    removeBtn.disabled = draft.files.length <= 1;
    removeBtn.addEventListener("click", () => {
      if (draft.files.length <= 1) return;
      draft.files.splice(idx, 1);
      renderBody();
    });

    head.append(titleInput, removeBtn);

    const textarea = document.createElement("textarea");
    textarea.className = "agents-modal-file-content";
    textarea.value = file.content;
    textarea.addEventListener("input", () => {
      draft.files[idx].content = textarea.value;
    });

    wrap.append(head, textarea);
    return wrap;
  };

  // -----------------------------------------------------------------------
  // Keyboard
  // -----------------------------------------------------------------------

  const onListKey = (e: KeyboardEvent): void => {
    if (mode !== "list") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length === 0) return;
      selectedIdx = (selectedIdx + 1) % filtered.length;
      const listEl = backdrop?.querySelector<HTMLElement>("[data-agents-list]");
      const previewEl = backdrop?.querySelector<HTMLElement>("[data-agents-preview]");
      if (listEl) updateAgentSelection(listEl, selectedIdx);
      if (previewEl) renderAgentPreview(previewEl, filtered[selectedIdx] ?? null);
      paintList();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      selectedIdx = (selectedIdx - 1 + filtered.length) % filtered.length;
      const listEl = backdrop?.querySelector<HTMLElement>("[data-agents-list]");
      const previewEl = backdrop?.querySelector<HTMLElement>("[data-agents-preview]");
      if (listEl) updateAgentSelection(listEl, selectedIdx);
      if (previewEl) renderAgentPreview(previewEl, filtered[selectedIdx] ?? null);
      paintList();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      activateSelected();
    }
  };

  const onGlobalKey = (e: KeyboardEvent): void => {
    if (!isOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (mode === "editor") {
        cancelEditor();
      } else {
        close();
      }
      return;
    }
    if (mode === "list" && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      beginCreate();
    }
  };

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  const open = (): void => {
    if (disposed || isOpen()) return;

    mode = "list";
    query = "";
    selectedIdx = 0;
    target = resolveInsertTarget(router);

    backdrop = document.createElement("div");
    backdrop.className = "agents-modal-backdrop";
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close();
    });

    const modal = document.createElement("div");
    modal.className = "agents-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Agents library");
    backdrop.append(modal);
    document.body.append(backdrop);

    unsubscribeState = controller.subscribe(() => {
      if (mode === "list") {
        rebuildFiltered();
        paintList();
      }
    });

    window.addEventListener("keydown", onGlobalKey, true);
    renderBody();
  };

  const close = (): void => {
    if (!isOpen()) return;
    window.removeEventListener("keydown", onGlobalKey, true);
    unsubscribeState?.();
    unsubscribeState = null;
    backdrop?.remove();
    backdrop = null;
    target = null;
    query = "";
    selectedIdx = 0;
    filtered = [];
    mode = "list";
    draft = draftFromAgent(null);
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

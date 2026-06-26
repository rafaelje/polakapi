import { invoke } from "@tauri-apps/api/core";

import { stringifyError } from "../../../shared/errors";
import { createListenerBag } from "../shared/listener-bag";
import { LOOP_CLIS, type LoopCli } from "../types";

import { phaseSlug, topologicalBatches } from "./graph";
import { serializePhasesManifest } from "./manifest";
import type { FileTab, Phase, Step2Action, Step2Context, Step2State, ViewRefs } from "./state";

export function renderView(
  slot: HTMLElement,
  state: Step2State,
  ctx: Step2Context,
  dispatch: (action: Step2Action) => void,
): ViewRefs {
  slot.classList.add("loop-step2");

  const root = document.createElement("div");
  root.className = "loop-step2-root";
  slot.replaceChildren(root);

  const listeners = createListenerBag();
  const { on } = listeners;

  let editorTextareaRef: HTMLTextAreaElement | null = null;

  function refresh(): void {
    root.replaceChildren();
    editorTextareaRef = null;
    root.append(renderHeader(), renderBody(), renderFooter());
  }

  function refreshToolbarOnly(): void {
    // Avoid full re-render so the textarea caret isn't lost.
    const old = root.querySelector(".loop-step2-toolbar");
    if (old && old.parentElement) {
      const updated = renderEditorToolbar();
      old.replaceWith(updated);
    }
  }

  function cleanup(): void {
    listeners.dispose();
    slot.classList.remove("loop-step2");
  }

  function renderHeader(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step2-header";

    const title = document.createElement("div");
    title.className = "loop-step2-title";
    title.textContent = "Step 2 · phase decomposition";

    const right = document.createElement("div");
    right.className = "loop-step2-header-right";

    const cliWrap = document.createElement("label");
    cliWrap.className = "loop-step2-cli-wrap";
    const cliLbl = document.createElement("span");
    cliLbl.className = "loop-step2-cli-label";
    cliLbl.textContent = "CLI";
    const cliSel = document.createElement("select");
    cliSel.className = "loop-step2-cli-select";
    cliSel.disabled = state.busy;
    for (const opt of LOOP_CLIS) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (opt === state.cli) o.selected = true;
      cliSel.appendChild(o);
    }
    on(cliSel, "change", () => {
      dispatch({ kind: "set-cli", cli: cliSel.value as LoopCli });
    });
    cliWrap.append(cliLbl, cliSel);

    const regen = document.createElement("button");
    regen.type = "button";
    regen.className = "loop-btn loop-btn-ghost";
    regen.textContent =
      state.busy && (state.status ?? "").startsWith("generating")
        ? "generating…"
        : "↻ regenerate from 01-problem.md";
    regen.disabled = state.busy;
    regen.title = "Invoke the agent with phase-decomposition.md on the consolidated problem";
    on(regen, "click", () => {
      const ok =
        state.phases.length === 0 ||
        window.confirm(
          "Regenerate the phases? Current manifests will be lost (files on disk remain, but the listing is replaced).",
        );
      if (ok) dispatch({ kind: "regenerate" });
    });

    const resetPrompt = document.createElement("button");
    resetPrompt.type = "button";
    resetPrompt.className = "loop-btn loop-btn-ghost";
    resetPrompt.textContent = "↑ reset prompt to global";
    resetPrompt.disabled = state.busy;
    resetPrompt.title =
      "Overwrites the run copy with the current contents of the global phase-decomposition.md (useful when the global was updated after the run was created)";
    on(resetPrompt, "click", () => {
      const ok = window.confirm(
        "Overwrite the run's phase-decomposition.md with the current global version? If you edited the run's prompt by hand, it will be lost.",
      );
      if (ok) dispatch({ kind: "reset-prompt-to-global" });
    });

    right.append(cliWrap, regen, resetPrompt);
    wrap.append(title, right);
    return wrap;
  }

  function renderBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "loop-step2-body";
    body.append(renderSidebar(), renderMain());
    return body;
  }

  function renderSidebar(): HTMLElement {
    const aside = document.createElement("aside");
    aside.className = "loop-step2-sidebar";

    const head = document.createElement("div");
    head.className = "loop-step2-sidebar-head";
    const lbl = document.createElement("span");
    lbl.className = "loop-step2-sidebar-title";
    lbl.textContent = `Phases (${state.phases.length})`;
    const add = document.createElement("button");
    add.type = "button";
    add.className = "loop-btn loop-btn-ghost loop-step2-add-phase";
    add.textContent = "+ add phase";
    add.disabled = state.busy;
    on(add, "click", () => dispatch({ kind: "add-phase" }));
    head.append(lbl, add);
    aside.appendChild(head);

    if (state.phases.length === 0) {
      const empty = document.createElement("p");
      empty.className = "loop-step2-sidebar-empty";
      empty.textContent = 'No phases. Click "↻ regenerate" or "+ add phase" to begin.';
      aside.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "loop-step2-phase-list";
      for (const phase of state.phases) {
        list.appendChild(renderPhaseItem(phase));
      }
      aside.appendChild(list);
    }

    aside.appendChild(renderTopologyPanel());
    return aside;
  }

  function renderPhaseItem(phase: Phase): HTMLLIElement {
    const slug = phaseSlug(phase);
    const item = document.createElement("li");
    item.className = "loop-step2-phase-item";
    if (slug === state.selectedSlug) item.classList.add("loop-step2-phase-item-active");

    const main = document.createElement("button");
    main.type = "button";
    main.className = "loop-step2-phase-main";
    main.disabled = state.busy;
    on(main, "click", () => dispatch({ kind: "select-phase", slug }));

    const top = document.createElement("div");
    top.className = "loop-step2-phase-top";
    const num = document.createElement("span");
    num.className = "loop-step2-phase-num";
    num.textContent = phase.id;
    const name = document.createElement("span");
    name.className = "loop-step2-phase-name";
    name.textContent = phase.name;
    const badges = document.createElement("span");
    badges.className = "loop-step2-phase-badges";
    const status = state.diskStatus.get(slug);
    if (status?.hasLogic) {
      const b = document.createElement("span");
      b.className = "loop-step2-badge loop-step2-badge-md";
      b.textContent = "md";
      b.title = "logic.md has content";
      badges.appendChild(b);
    }
    if (status?.hasVisual) {
      const b = document.createElement("span");
      b.className = "loop-step2-badge loop-step2-badge-html";
      b.textContent = "html";
      b.title = "visual.html has content";
      badges.appendChild(b);
    }
    top.append(num, name, badges);

    const deps = document.createElement("div");
    deps.className = "loop-step2-phase-deps";
    if (phase.dependsOn.length === 0) {
      deps.textContent = "no dependencies";
      deps.classList.add("loop-step2-phase-deps-empty");
    } else {
      deps.textContent = `depends on: ${phase.dependsOn.join(", ")}`;
    }

    main.append(top, deps);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "loop-step2-phase-delete";
    del.textContent = "✕";
    del.title = "delete phase";
    del.disabled = state.busy;
    on(del, "click", (e: Event) => {
      e.stopPropagation();
      dispatch({ kind: "delete-phase", slug });
    });

    item.append(main, del);
    return item;
  }

  function renderTopologyPanel(): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "loop-step2-topology";

    const head = document.createElement("div");
    head.className = "loop-step2-topology-head";
    head.textContent = "Execution topology";
    panel.appendChild(head);

    if (state.phases.length === 0) {
      const p = document.createElement("p");
      p.className = "loop-step2-topology-empty";
      p.textContent = "No phases to sort.";
      panel.appendChild(p);
      return panel;
    }

    const batches = topologicalBatches(state.phases);
    if (!batches) {
      const p = document.createElement("p");
      p.className = "loop-step2-topology-error";
      p.textContent = "There is a cycle in the dependencies — cannot sort.";
      panel.appendChild(p);
      return panel;
    }

    const lanes = document.createElement("ol");
    lanes.className = "loop-step2-lanes";
    for (let i = 0; i < batches.length; i++) {
      const lane = document.createElement("li");
      lane.className = "loop-step2-lane";
      const lbl = document.createElement("div");
      lbl.className = "loop-step2-lane-label";
      lbl.textContent = `batch ${i + 1}`;
      const items = document.createElement("div");
      items.className = "loop-step2-lane-items";
      for (const phase of batches[i]) {
        const chip = document.createElement("span");
        chip.className = "loop-step2-lane-chip";
        chip.textContent = `${phase.id} · ${phase.name}`;
        items.appendChild(chip);
      }
      lane.append(lbl, items);
      lanes.appendChild(lane);
    }
    panel.appendChild(lanes);
    return panel;
  }

  function renderMain(): HTMLElement {
    const main = document.createElement("section");
    main.className = "loop-step2-main";

    const phase = state.phases.find((p) => phaseSlug(p) === state.selectedSlug);
    if (!phase) {
      const empty = document.createElement("p");
      empty.className = "loop-step2-main-empty";
      empty.textContent = "Pick a phase from the sidebar or add a new one.";
      main.appendChild(empty);
      return main;
    }

    main.append(
      renderTabs(phase),
      renderEditor(phase),
      renderEditorToolbar(),
      renderDepsEditor(phase),
    );
    return main;
  }

  function renderTabs(phase: Phase): HTMLElement {
    const tabs = document.createElement("div");
    tabs.className = "loop-step2-tabs";
    const slug = phaseSlug(phase);
    const status = state.diskStatus.get(slug);
    const showVisualTab = phase.hasVisual || status?.hasVisual === true;

    for (const tab of ["logic.md", "visual.html"] as const) {
      if (tab === "visual.html" && !showVisualTab) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "loop-step2-tab";
      if (tab === state.activeTab) btn.classList.add("loop-step2-tab-active");
      btn.textContent = tab;
      const key = bufferKey(slug, tab);
      if (state.dirty.has(key)) {
        const dot = document.createElement("span");
        dot.className = "loop-step2-tab-dirty";
        dot.textContent = " •";
        btn.appendChild(dot);
      }
      on(btn, "click", () => dispatch({ kind: "set-tab", tab }));
      tabs.appendChild(btn);
    }

    if (!showVisualTab) {
      const note = document.createElement("button");
      note.type = "button";
      note.className = "loop-step2-tab loop-step2-tab-add-visual";
      note.textContent = "+ visual.html";
      note.title = "Mark the phase as visual and add visual.html";
      on(note, "click", () => {
        // View mutates state.phases directly: this transition isn't modeled in the action set.
        void (async (): Promise<void> => {
          const updated = state.phases.map((p) =>
            phaseSlug(p) === slug ? { ...p, hasVisual: true } : p,
          );
          state.phases = updated;
          try {
            await invoke<string>("loop_create_phase_dir", {
              projectPath: ctx.projectPath,
              runId: ctx.runId,
              phaseSlug: slug,
              withVisual: true,
            });
            await invoke<void>("loop_write_run_file", {
              projectPath: ctx.projectPath,
              runId: ctx.runId,
              file: "02-phases.md",
              content: serializePhasesManifest(state.phases),
            });
            state.activeTab = "visual.html";
          } catch (err) {
            state.status = `error adding visual: ${stringifyError(err)}`;
          }
          refresh();
        })();
      });
      tabs.appendChild(note);
    }

    return tabs;
  }

  function renderEditor(phase: Phase): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step2-editor-wrap";

    const slug = phaseSlug(phase);
    const key = bufferKey(slug, state.activeTab);
    const content = state.editorBuffers.get(key) ?? "";

    const ta = document.createElement("textarea");
    ta.className = "loop-step2-editor";
    ta.spellcheck = false;
    ta.value = content;
    ta.disabled = state.busy;
    ta.placeholder =
      state.activeTab === "logic.md"
        ? "Logic content of the phase (markdown). Cmd+S to save."
        : "HTML of the phase's visual output.";
    on(ta, "input", () => {
      dispatch({
        kind: "set-buffer",
        slug,
        tab: state.activeTab,
        value: ta.value,
      });
    });
    on(ta, "keydown", (e: KeyboardEvent) => {
      if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        dispatch({ kind: "save" });
      }
    });
    editorTextareaRef = ta;
    wrap.appendChild(ta);
    return wrap;
  }

  function renderEditorToolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "loop-step2-toolbar";

    const phase = state.phases.find((p) => phaseSlug(p) === state.selectedSlug);
    const slug = phase ? phaseSlug(phase) : null;
    const key = slug ? bufferKey(slug, state.activeTab) : "";
    const dirty = key ? state.dirty.has(key) : false;

    const save = document.createElement("button");
    save.type = "button";
    save.className = "loop-btn loop-btn-primary loop-step2-save";
    save.textContent = dirty ? "save •" : "save";
    save.disabled = state.busy || !dirty;
    on(save, "click", () => dispatch({ kind: "save" }));

    const aiInput = document.createElement("input");
    aiInput.type = "text";
    aiInput.className = "loop-step2-ai-input";
    aiInput.placeholder = "instruction for AI (about the selection, or all of it)…";
    aiInput.disabled = state.busy;

    const aiBtn = document.createElement("button");
    aiBtn.type = "button";
    aiBtn.className = "loop-btn loop-step2-ai-btn";
    aiBtn.textContent = "✨ edit with AI";
    aiBtn.disabled = state.busy;
    on(aiBtn, "click", () => {
      const instr = aiInput.value.trim();
      if (!instr) return;
      dispatch({ kind: "ai-edit", instruction: instr });
      aiInput.value = "";
    });
    on(aiInput, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        aiBtn.click();
      }
    });

    const statusEl = document.createElement("span");
    statusEl.className = "loop-step2-toolbar-status";
    if (state.status) {
      statusEl.textContent = state.status;
      if (state.status.startsWith("error")) {
        statusEl.classList.add("loop-step2-toolbar-status-error");
      }
    }

    bar.append(save, aiInput, aiBtn, statusEl);
    return bar;
  }

  function renderDepsEditor(phase: Phase): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step2-deps-editor";

    const lbl = document.createElement("div");
    lbl.className = "loop-step2-deps-label";
    lbl.textContent = "Depends on:";

    const list = document.createElement("div");
    list.className = "loop-step2-deps-list";

    const others = state.phases.filter((p) => p.id !== phase.id);
    if (others.length === 0) {
      const note = document.createElement("p");
      note.className = "loop-step2-deps-empty";
      note.textContent = "There are no other phases — this is the only one.";
      list.appendChild(note);
    } else {
      for (const other of others) {
        const item = document.createElement("label");
        item.className = "loop-step2-deps-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = other.id;
        cb.checked = phase.dependsOn.includes(other.id);
        cb.disabled = state.busy;
        on(cb, "change", () => {
          const checked = list.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked");
          const deps = [...checked].map((c) => c.value);
          dispatch({ kind: "set-depends", slug: phaseSlug(phase), deps });
        });
        const span = document.createElement("span");
        span.textContent = `${other.id} · ${other.name}`;
        item.append(cb, span);
        list.appendChild(item);
      }
    }

    wrap.append(lbl, list);

    if (state.cycleError) {
      const err = document.createElement("p");
      err.className = "loop-step2-deps-error";
      err.textContent = state.cycleError;
      wrap.appendChild(err);
    }
    return wrap;
  }

  function renderFooter(): HTMLElement {
    const f = document.createElement("div");
    f.className = "loop-step2-footer";

    const info = document.createElement("span");
    info.className = "loop-step2-footer-info";
    const total = state.phases.length;
    const ready = state.phases.filter((p) => {
      const s = state.diskStatus.get(phaseSlug(p));
      return s?.hasLogic === true;
    }).length;
    info.textContent =
      total === 0
        ? "no phases"
        : ready === total
          ? `${total}/${total} phases with logic.md`
          : `${ready}/${total} phases with logic.md`;

    const advance = document.createElement("button");
    advance.type = "button";
    advance.className = "loop-btn loop-btn-primary";
    advance.textContent = "→ Step 3";
    const canAdvance = total > 0 && ready === total && !state.busy;
    advance.disabled = !canAdvance;
    advance.title = canAdvance ? "Advance to the run setup" : "All phases must have logic.md saved";
    on(advance, "click", () => dispatch({ kind: "advance" }));

    f.append(info, advance);
    return f;
  }

  refresh();
  void ctx;

  return {
    refresh,
    refreshToolbarOnly,
    cleanup,
    editorTextarea: () => editorTextareaRef,
  };
}

export function bufferKey(slug: string, tab: FileTab): string {
  return `${slug}:${tab}`;
}

export function buildAiEditPrompt(
  full: string,
  selection: string,
  instruction: string,
  tab: FileTab,
): string {
  const kind = tab === "logic.md" ? "Markdown" : "HTML";
  if (selection.trim()) {
    return [
      `# Task`,
      `You have the file \`${tab}\` (${kind}) open. The user selected a fragment and requested a change.`,
      ``,
      `# Full document`,
      "```",
      full,
      "```",
      ``,
      `# Selected fragment (what you will replace)`,
      "```",
      selection,
      "```",
      ``,
      `# User instruction`,
      instruction,
      ``,
      `# Response`,
      `Return ONLY the new content that replaces the selected fragment. No code fences, no preamble. Preserve the style (${kind}, technical English, no emojis).`,
    ].join("\n");
  }
  return [
    `# Task`,
    `Rewrite the file \`${tab}\` (${kind}) following the user's instruction.`,
    ``,
    `# Current document`,
    "```",
    full,
    "```",
    ``,
    `# User instruction`,
    instruction,
    ``,
    `# Response`,
    `Return ONLY the complete content of the rewritten file. No code fences, no preamble.`,
  ].join("\n");
}

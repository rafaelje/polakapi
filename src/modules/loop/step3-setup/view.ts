import { promptModal } from "../../../shared/ui/modal";

import { createListenerBag } from "../shared/listener-bag";
import { topologicalBatches } from "../step2-phases";
import {
  DEFAULT_AGENT_SLOT,
  LOOP_CLIS,
  LOOP_PROMPT_NAMES,
  defaultModelFor,
  promptBlurb,
  promptToRole,
} from "../types";
import type { LoopCli, LoopProfileId, LoopPromptName } from "../types";

import { canExecute, countInvalidSlots, isPromptModified } from "./helpers";
import type { Step3Action, Step3Context, Step3State, ViewRefs } from "./state";

export function renderView(
  slot: HTMLElement,
  state: Step3State,
  ctx: Step3Context,
  dispatch: (action: Step3Action) => void,
): ViewRefs {
  slot.classList.add("loop-step3");

  const root = document.createElement("div");
  root.className = "loop-step3-root";
  slot.replaceChildren(root);

  const listeners = createListenerBag();
  const { on } = listeners;

  function refresh(): void {
    root.replaceChildren();
    root.append(renderTopBar(), renderBody(), renderFooter());
  }

  function refreshValidationsOnly(): void {
    // Avoid re-rendering the textarea to preserve the caret.
    const sidebar = root.querySelector(".loop-step3-sidebar");
    if (sidebar) sidebar.replaceWith(renderSidebar());
    const footer = root.querySelector(".loop-step3-footer");
    if (footer) footer.replaceWith(renderFooter());
    const mainSlot = root.querySelector(".loop-step3-main-validation");
    if (mainSlot) mainSlot.replaceWith(renderMainValidationRow(state.selectedPrompt));
  }

  function cleanup(): void {
    listeners.dispose();
    slot.classList.remove("loop-step3");
  }

  function renderTopBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "loop-step3-topbar";

    const left = document.createElement("div");
    left.className = "loop-step3-topbar-left";
    const proj = document.createElement("span");
    proj.className = "loop-step3-topbar-project";
    proj.textContent = ctx.projectName;
    proj.title = ctx.projectPath;
    const sep = document.createElement("span");
    sep.className = "loop-step3-topbar-sep";
    sep.textContent = "·";
    const cli = document.createElement("span");
    cli.className = "loop-step3-topbar-cli";
    cli.textContent = ctx.suggestedCli ? `suggested CLI: ${ctx.suggestedCli}` : "no suggested CLI";
    left.append(proj, sep, cli);

    const center = document.createElement("div");
    center.className = "loop-step3-topbar-center";
    center.append(renderModeSelector(), renderProfileBlock());

    const right = document.createElement("div");
    right.className = "loop-step3-topbar-right";
    if (state.status) {
      const s = document.createElement("span");
      s.className = "loop-step3-topbar-status";
      if (state.status.startsWith("error")) {
        s.classList.add("loop-step3-topbar-status-error");
      }
      s.textContent = state.status;
      right.append(s);
    }

    bar.append(left, center, right);
    return bar;
  }

  function renderModeSelector(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step3-mode";

    const lbl = document.createElement("span");
    lbl.className = "loop-step3-mode-label";
    lbl.textContent = "mode";

    const group = document.createElement("div");
    group.className = "loop-step3-mode-group";
    for (const mode of ["sequential", "hybrid"] as const) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "loop-step3-mode-btn";
      if (mode === state.mode) btn.classList.add("loop-step3-mode-btn-active");
      btn.textContent = mode === "sequential" ? "sequential" : "hybrid";
      btn.disabled = state.busy;
      on(btn, "click", () => dispatch({ kind: "set-mode", mode }));
      group.appendChild(btn);
    }
    wrap.append(lbl, group);

    if (state.mode === "hybrid" && state.phases.length > 0) {
      const batches = topologicalBatches(state.phases);
      if (batches && batches.every((b) => b.length === 1)) {
        const hint = document.createElement("span");
        hint.className = "loop-step3-mode-hint";
        hint.textContent = "(hybrid ≡ sequential: linear DAG)";
        wrap.appendChild(hint);
      }
    }

    return wrap;
  }

  function renderProfileBlock(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step3-profile";

    const lbl = document.createElement("span");
    lbl.className = "loop-step3-profile-label";
    lbl.textContent = "profile";

    const sel = document.createElement("select");
    sel.className = "loop-step3-profile-select";
    sel.disabled = state.busy;
    sel.setAttribute("aria-label", "CLI/model matrix profile");
    const optNone = document.createElement("option");
    optNone.value = "";
    optNone.textContent =
      state.profiles.length === 0
        ? "— no saved profiles (use 'save as…') —"
        : "— no profile (defaults) —";
    if (state.loadedProfileId === null) optNone.selected = true;
    sel.appendChild(optNone);
    for (const p of state.profiles) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      if (p.id === state.loadedProfileId) o.selected = true;
      sel.appendChild(o);
    }
    on(sel, "change", () => {
      const v = sel.value;
      const id: LoopProfileId | null = v ? (v as LoopProfileId) : null;
      dispatch({ kind: "load-profile", id });
    });

    const save = document.createElement("button");
    save.type = "button";
    save.className = "loop-btn loop-btn-ghost";
    save.textContent = "save";
    save.disabled = state.busy || state.loadedProfileId === null;
    save.title =
      state.loadedProfileId === null
        ? "Load a profile first or use 'save as…'"
        : "Overwrites the loaded profile with the current matrix";
    on(save, "click", () => dispatch({ kind: "save-profile" }));

    const saveAs = document.createElement("button");
    saveAs.type = "button";
    saveAs.className = "loop-btn loop-btn-ghost";
    saveAs.textContent = "save as…";
    saveAs.disabled = state.busy;
    on(saveAs, "click", () => {
      void (async () => {
        const name = await promptModal({
          title: "Save profile",
          message: "Profile name (saved in profiles.json, local to this machine).",
          placeholder: "e.g. claude-only",
          confirmLabel: "save",
          cancelLabel: "cancel",
        });
        if (name !== null) dispatch({ kind: "save-profile-as", name });
      })();
    });

    wrap.append(lbl, sel, save, saveAs);
    return wrap;
  }

  function renderBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "loop-step3-body";
    body.append(renderSidebar(), renderMain());
    return body;
  }

  function renderSidebar(): HTMLElement {
    const aside = document.createElement("aside");
    aside.className = "loop-step3-sidebar";

    const head = document.createElement("div");
    head.className = "loop-step3-sidebar-head";
    head.textContent = "Run prompts";
    aside.appendChild(head);

    const list = document.createElement("ul");
    list.className = "loop-step3-prompt-list";

    const preHeading = document.createElement("li");
    preHeading.className = "loop-step3-prompt-section";
    preHeading.textContent = "Pre-phases";
    list.appendChild(preHeading);
    for (const name of LOOP_PROMPT_NAMES.slice(0, 2)) {
      list.appendChild(renderPromptItem(name));
    }

    const agentHeading = document.createElement("li");
    agentHeading.className = "loop-step3-prompt-section";
    agentHeading.textContent = "Step 3 agents";
    list.appendChild(agentHeading);
    for (const name of LOOP_PROMPT_NAMES.slice(2)) {
      list.appendChild(renderPromptItem(name));
    }

    aside.appendChild(list);
    return aside;
  }

  function renderPromptItem(name: LoopPromptName): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "loop-step3-prompt-item";
    if (name === state.selectedPrompt) item.classList.add("loop-step3-prompt-item-active");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "loop-step3-prompt-btn";
    btn.disabled = state.busy;
    on(btn, "click", () => dispatch({ kind: "select-prompt", name }));

    const titleRow = document.createElement("div");
    titleRow.className = "loop-step3-prompt-title-row";
    const title = document.createElement("span");
    title.className = "loop-step3-prompt-title";
    title.textContent = name;
    titleRow.appendChild(title);

    const badge = document.createElement("span");
    badge.className = "loop-step3-prompt-badge";
    const modified = isPromptModified(state, name);
    if (modified) {
      badge.classList.add("loop-step3-prompt-badge-modified");
      badge.textContent = "modified";
    } else {
      badge.classList.add("loop-step3-prompt-badge-default");
      badge.textContent = "default";
    }
    titleRow.appendChild(badge);

    btn.appendChild(titleRow);

    const role = promptToRole(name);
    if (role) {
      const meta = document.createElement("div");
      meta.className = "loop-step3-prompt-meta";
      const slot = state.matrix[role];
      const text = document.createElement("span");
      text.className = "loop-step3-prompt-cli";
      text.textContent = `${slot.cli} · ${slot.model}`;
      meta.appendChild(text);

      const v = state.validations.get(role);
      const dot = document.createElement("span");
      dot.className = "loop-step3-prompt-dot";
      if (!v) {
        dot.classList.add("loop-step3-prompt-dot-unknown");
        dot.title = "not validated";
      } else if ("ok" in v && v.ok === null) {
        dot.classList.add("loop-step3-prompt-dot-pending");
        dot.title = "validating…";
      } else if (v.ok === true) {
        dot.classList.add("loop-step3-prompt-dot-ok");
        dot.title = "CLI and model valid";
      } else {
        dot.classList.add("loop-step3-prompt-dot-error");
        dot.title = v.reason ?? "invalid";
      }
      meta.appendChild(dot);
      btn.appendChild(meta);
    } else {
      const meta = document.createElement("div");
      meta.className = "loop-step3-prompt-meta";
      const text = document.createElement("span");
      text.className = "loop-step3-prompt-cli loop-step3-prompt-cli-muted";
      text.textContent = "(used in step 1/2)";
      meta.appendChild(text);
      btn.appendChild(meta);
    }

    item.appendChild(btn);
    return item;
  }

  function renderMain(): HTMLElement {
    const main = document.createElement("section");
    main.className = "loop-step3-main";
    const name = state.selectedPrompt;
    main.append(
      renderMainHeader(name),
      renderMainValidationRow(name),
      renderMainEditor(name),
      renderMainEditorToolbar(name),
    );
    return main;
  }

  function renderMainHeader(name: LoopPromptName): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step3-main-header";

    const blurb = promptBlurb(name);
    const title = document.createElement("div");
    title.className = "loop-step3-main-title";
    title.textContent = blurb.title;
    const io = document.createElement("div");
    io.className = "loop-step3-main-io";
    io.textContent = blurb.io;

    wrap.append(title, io);
    return wrap;
  }

  function renderMainValidationRow(name: LoopPromptName): HTMLElement {
    const row = document.createElement("div");
    row.className = "loop-step3-main-validation";

    const role = promptToRole(name);
    if (!role) {
      const note = document.createElement("p");
      note.className = "loop-step3-main-validation-note";
      note.textContent =
        name === "problem-intake.md"
          ? "The intake CLI/model is chosen in Step 1. Here you only edit the agent prompt."
          : "The decomposition CLI/model is chosen in Step 2. Here you only edit the agent prompt.";
      row.appendChild(note);
      return row;
    }

    const slot = state.matrix[role];
    const v = state.validations.get(role);
    const failed = v && "ok" in v && v.ok === false;

    const cliWrap = document.createElement("label");
    cliWrap.className = "loop-step3-main-field";
    const cliLbl = document.createElement("span");
    cliLbl.className = "loop-step3-main-field-label";
    cliLbl.textContent = "CLI";
    const cliSel = document.createElement("select");
    cliSel.className = "loop-step3-main-field-select";
    if (failed) cliSel.classList.add("loop-step3-main-field-select-error");
    cliSel.disabled = state.busy;
    for (const c of LOOP_CLIS) {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      if (c === slot.cli) o.selected = true;
      cliSel.appendChild(o);
    }
    on(cliSel, "change", () => {
      const nextCli = cliSel.value as LoopCli;
      // Reset the model to the new CLI's default to avoid pointing at a model the CLI doesn't know.
      const nextModel = slot.cli === nextCli ? slot.model : defaultModelFor(nextCli);
      dispatch({
        kind: "set-slot",
        role,
        cli: nextCli,
        model: nextModel,
      });
    });
    cliWrap.append(cliLbl, cliSel);

    const modelWrap = document.createElement("label");
    modelWrap.className = "loop-step3-main-field";
    const modelLbl = document.createElement("span");
    modelLbl.className = "loop-step3-main-field-label";
    modelLbl.textContent = "model";
    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.className = "loop-step3-main-field-input";
    if (failed) modelInput.classList.add("loop-step3-main-field-input-error");
    modelInput.value = slot.model;
    modelInput.disabled = state.busy;
    on(modelInput, "change", () => {
      dispatch({
        kind: "set-slot",
        role,
        cli: slot.cli,
        model: modelInput.value.trim() || DEFAULT_AGENT_SLOT.model,
      });
    });
    modelWrap.append(modelLbl, modelInput);

    row.append(cliWrap, modelWrap);

    if (failed) {
      const err = document.createElement("span");
      err.className = "loop-step3-main-validation-error";
      err.textContent = v?.reason ?? "invalid";
      row.appendChild(err);
    } else if (v && "ok" in v && v.ok === null) {
      const pending = document.createElement("span");
      pending.className = "loop-step3-main-validation-pending";
      pending.textContent = "validating…";
      row.appendChild(pending);
    } else if (v && "ok" in v && v.ok === true) {
      const okEl = document.createElement("span");
      okEl.className = "loop-step3-main-validation-ok";
      okEl.textContent = "✓";
      row.appendChild(okEl);
    }

    return row;
  }

  function renderMainEditor(name: LoopPromptName): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step3-main-editor-wrap";
    const content = state.promptBuffers.get(name) ?? state.globals.get(name) ?? "";
    const ta = document.createElement("textarea");
    ta.className = "loop-step3-main-editor";
    ta.spellcheck = false;
    ta.value = content;
    ta.disabled = state.busy;
    ta.placeholder = "Prompt content (markdown). Cmd+S to promote to global.";
    ta.setAttribute("aria-label", `editor for prompt ${name} — Cmd+S saves as global default`);
    on(ta, "input", () => {
      dispatch({ kind: "set-prompt-buffer", name, value: ta.value });
    });
    on(ta, "keydown", (e: KeyboardEvent) => {
      if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (state.busy || !isPromptModified(state, name)) return;
        dispatch({ kind: "promote-to-global", name });
      }
    });
    wrap.appendChild(ta);
    return wrap;
  }

  function renderMainEditorToolbar(name: LoopPromptName): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "loop-step3-main-toolbar";

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "loop-btn loop-btn-ghost";
    reset.textContent = "↑ reset to global";
    reset.disabled = state.busy;
    reset.title = "Reloads the global from disk and overwrites the run prompt";
    on(reset, "click", () => dispatch({ kind: "reset-to-global", name }));

    const promote = document.createElement("button");
    promote.type = "button";
    promote.className = "loop-btn loop-btn-ghost";
    promote.textContent = "↓ save as global default";
    promote.disabled = state.busy || !isPromptModified(state, name);
    promote.title = "Overwrites the global with the current content — affects future runs";
    on(promote, "click", () => dispatch({ kind: "promote-to-global", name }));

    const reseed = document.createElement("button");
    reseed.type = "button";
    reseed.className = "loop-btn loop-btn-ghost";
    reseed.textContent = "↻ reseed from bundled";
    reseed.disabled = state.busy;
    reseed.title =
      "Restores the bundled prompt compiled into the binary, overwriting the global and the run copy";
    on(reseed, "click", () => dispatch({ kind: "reseed-from-bundled", name }));

    bar.append(reset, promote, reseed);
    return bar;
  }

  function renderFooter(): HTMLElement {
    const f = document.createElement("div");
    f.className = "loop-step3-footer";

    const config = document.createElement("div");
    config.className = "loop-step3-config-row";

    const retriesWrap = document.createElement("label");
    retriesWrap.className = "loop-step3-config-field";
    const retriesLbl = document.createElement("span");
    retriesLbl.className = "loop-step3-config-label";
    retriesLbl.textContent = "max retries";
    const retriesInput = document.createElement("input");
    retriesInput.type = "number";
    retriesInput.value = String(state.config.maxRetries);
    retriesInput.readOnly = true;
    retriesInput.disabled = true;
    retriesInput.className = "loop-step3-config-input loop-step3-config-input-readonly";
    retriesInput.title = "fixed cap of 3 with propagated warning";
    retriesWrap.append(retriesLbl, retriesInput);

    const onFailWrap = document.createElement("label");
    onFailWrap.className = "loop-step3-config-field";
    const onFailLbl = document.createElement("span");
    onFailLbl.className = "loop-step3-config-label";
    onFailLbl.textContent = "on fail";
    const onFailInput = document.createElement("input");
    onFailInput.type = "text";
    onFailInput.value = "propagate warning";
    onFailInput.readOnly = true;
    onFailInput.disabled = true;
    onFailInput.className = "loop-step3-config-input loop-step3-config-input-readonly";
    onFailInput.title = "propagate warning to knowledge";
    onFailWrap.append(onFailLbl, onFailInput);

    config.append(retriesWrap, onFailWrap);

    const exec = document.createElement("button");
    exec.type = "button";
    exec.className = "loop-btn loop-btn-primary loop-step3-execute";
    const allowed = canExecute(state);
    exec.disabled = !allowed;
    const invalid = countInvalidSlots(state);
    if (invalid > 0) {
      exec.title = `${invalid} invalid slot(s) — fix them before running`;
    } else if (state.busy) {
      exec.title = "waiting for validation to finish";
    } else {
      exec.title = "Runs the run with the current configuration";
    }
    exec.textContent = "▶ run";
    on(exec, "click", () => dispatch({ kind: "execute" }));

    f.append(config, exec);
    return f;
  }

  refresh();

  return {
    refresh,
    refreshValidationsOnly,
    cleanup,
  };
}

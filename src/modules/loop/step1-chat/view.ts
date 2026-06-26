import { createListenerBag } from "../shared/listener-bag";
import { LOOP_CLIS, type LoopCli } from "../types";

import type { ChatAction, ChatTurn, RunSummary, Step1Context, Step1State, ViewRefs } from "./state";

export function renderView(
  slot: HTMLElement,
  state: Step1State,
  ctx: Step1Context,
  dispatch: (action: ChatAction) => void | Promise<void>,
): ViewRefs {
  // The chrome's slot uses `display: flex; align-items: center` for
  // placeholders; override to a vertical full-height layout for the chat.
  slot.classList.add("loop-step1");

  const root = document.createElement("div");
  root.className = "loop-step1-root";
  slot.replaceChildren(root);

  const listeners = createListenerBag();
  const { on } = listeners;

  function refresh(): void {
    root.replaceChildren();
    root.append(renderHeader());
    if (state.pickerOpen) root.append(renderPicker());
    if (state.consolidatedExists) root.append(renderResumeBanner());
    root.append(renderTurns(), renderComposer());
  }

  function renderPicker(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step1-picker";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-label", "Previous runs of the project");

    const header = document.createElement("div");
    header.className = "loop-step1-picker-header";
    const title = document.createElement("strong");
    title.textContent = "Previous runs";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "loop-btn loop-btn-ghost";
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close picker");
    on(closeBtn, "click", () => {
      void dispatch({ kind: "toggle-picker" });
    });
    header.append(title, closeBtn);
    wrap.append(header);

    if (state.pickerLoading) {
      const p = document.createElement("p");
      p.className = "loop-step1-picker-empty";
      p.textContent = "loading runs…";
      wrap.append(p);
      return wrap;
    }
    const list = state.runsList ?? [];
    if (list.length === 0) {
      const p = document.createElement("p");
      p.className = "loop-step1-picker-empty";
      p.textContent = "no previous runs in this project.";
      wrap.append(p);
      return wrap;
    }

    const ul = document.createElement("ul");
    ul.className = "loop-step1-picker-list";
    for (const run of list) {
      if (run.runId === ctx.runId) continue;
      ul.append(renderPickerItem(run));
    }
    if (ul.children.length === 0) {
      const p = document.createElement("p");
      p.className = "loop-step1-picker-empty";
      p.textContent = "the only existing run is the current one.";
      wrap.append(p);
    } else {
      wrap.append(ul);
    }
    return wrap;
  }

  function renderPickerItem(run: RunSummary): HTMLElement {
    const li = document.createElement("li");
    li.className = "loop-step1-picker-item";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "loop-step1-picker-item-main";

    const preview = document.createElement("div");
    preview.className = "loop-step1-picker-item-preview";
    preview.textContent = run.preview ?? "(no preview)";

    const meta = document.createElement("div");
    meta.className = "loop-step1-picker-item-meta";
    const date = new Date(run.lastModifiedMs);
    const dateText = isFinite(date.getTime()) ? date.toLocaleString() : "(unknown date)";
    const flags: string[] = [];
    if (run.hasDraft) flags.push("draft");
    if (run.hasConsolidated) flags.push("consolidated");
    if (run.hasPhases) flags.push("phases");
    meta.textContent = `${dateText} · ${flags.join(" · ") || "empty"} · ${run.runId.slice(0, 8)}`;

    main.append(preview, meta);
    on(main, "click", () => {
      // Jump to the furthest step whose inputs are already on disk.
      const step: 1 | 2 | 3 = run.hasPhases ? 3 : run.hasConsolidated ? 2 : 1;
      void dispatch({ kind: "adopt-run", runId: run.runId, step });
    });

    li.append(main);
    return li;
  }

  function renderResumeBanner(): HTMLElement {
    const banner = document.createElement("div");
    banner.className = "loop-step1-resume-banner";
    banner.setAttribute("role", "status");

    const text = document.createElement("span");
    text.className = "loop-step1-resume-banner-text";
    text.textContent = "There is already a consolidated 01-problem.md in this run.";

    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "loop-btn loop-btn-primary";
    skip.textContent = "→ go to step 2";
    skip.title = "Skip to step 2 using the existing 01-problem.md";
    on(skip, "click", () => {
      void dispatch({ kind: "skip-to-step-2" });
    });

    banner.append(text, skip);
    return banner;
  }

  function cleanup(): void {
    listeners.dispose();
    slot.classList.remove("loop-step1");
  }

  function renderHeader(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "loop-step1-header";

    const title = document.createElement("div");
    title.className = "loop-step1-title";
    title.textContent = "Step 1 · refine the problem";

    const editPrompt = document.createElement("button");
    editPrompt.type = "button";
    editPrompt.className = "loop-btn loop-btn-ghost loop-step1-edit-prompt";
    editPrompt.textContent = "✎ edit system prompt";
    editPrompt.title = "Open the run's problem-intake.md in the system editor";
    on(editPrompt, "click", () => {
      void dispatch({ kind: "edit-system-prompt" });
    });

    const actions = document.createElement("div");
    actions.className = "loop-step1-header-actions";

    if (ctx.onAdoptRun) {
      const picker = document.createElement("button");
      picker.type = "button";
      picker.className = "loop-btn loop-btn-ghost";
      picker.textContent = state.pickerOpen ? "↺ previous runs ✓" : "↺ previous runs";
      picker.title = "List previous runs of the project to resume one";
      on(picker, "click", () => {
        void dispatch({ kind: "toggle-picker" });
      });
      actions.append(picker);
    }
    actions.append(editPrompt);

    wrap.append(title, actions);
    return wrap;
  }

  function renderTurns(): HTMLElement {
    const list = document.createElement("div");
    list.className = "loop-step1-turns";

    if (state.turns.length === 0) {
      const empty = document.createElement("p");
      empty.className = "loop-step1-empty";
      empty.textContent =
        "Tell me about the problem you're working on. The agent will ask questions until it's ready to break it down into phases.";
      list.appendChild(empty);
      return list;
    }

    for (const turn of state.turns) {
      list.append(renderTurn(turn));
    }
    // Defer to next frame so layout has settled before measuring scrollHeight.
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
    return list;
  }

  function renderTurn(turn: ChatTurn): HTMLElement {
    const block = document.createElement("article");
    block.className = "loop-step1-turn";

    if (turn.intro) {
      const intro = document.createElement("div");
      intro.className = "loop-step1-intro-label";
      intro.textContent = "automatic project analysis";
      block.append(intro);
    }

    const userRow = document.createElement("div");
    userRow.className = "loop-step1-row loop-step1-row-user";
    const userLabel = document.createElement("span");
    userLabel.className = "loop-step1-rolelabel";
    userLabel.textContent = "you";
    const userText = document.createElement("div");
    userText.className = "loop-step1-msg";
    userText.textContent = turn.user;
    userRow.append(userLabel, userText);

    const agentRow = document.createElement("div");
    agentRow.className = "loop-step1-row loop-step1-row-agent";
    const agentLabel = document.createElement("span");
    agentLabel.className = "loop-step1-rolelabel";
    agentLabel.textContent = state.cli;
    const agentText = document.createElement("div");
    agentText.className = "loop-step1-msg";
    if (turn.pending) {
      agentText.classList.add("loop-step1-msg-pending");
      agentText.textContent = "thinking…";
    } else if (turn.error) {
      // Show partial output (if any) above the error note.
      if (turn.assistant) {
        agentText.textContent = turn.assistant;
      } else {
        agentText.classList.add("loop-step1-msg-empty");
        agentText.textContent = "(no response)";
      }
    } else {
      agentText.textContent = turn.assistant;
    }
    agentRow.append(agentLabel, agentText);

    if (turn.intro) {
      block.append(agentRow);
    } else {
      block.append(userRow, agentRow);
    }

    if (turn.error) {
      const err = document.createElement("p");
      err.className = "loop-step1-turn-error";
      err.textContent = `error: ${turn.error}`;
      block.append(err);
    }

    if (turn.tokensIn != null || turn.tokensOut != null) {
      const meta = document.createElement("p");
      meta.className = "loop-step1-turn-meta";
      const parts: string[] = [];
      if (turn.tokensIn != null) parts.push(`in ${turn.tokensIn}`);
      if (turn.tokensOut != null) parts.push(`out ${turn.tokensOut}`);
      meta.textContent = parts.join(" · ");
      block.append(meta);
    }

    return block;
  }

  function renderComposer(): HTMLElement {
    const composer = document.createElement("div");
    composer.className = "loop-step1-composer";

    const toolbar = document.createElement("div");
    toolbar.className = "loop-step1-toolbar";

    const cliWrap = document.createElement("label");
    cliWrap.className = "loop-step1-cli-wrap";
    const cliLbl = document.createElement("span");
    cliLbl.className = "loop-step1-cli-label";
    cliLbl.textContent = "CLI";
    const cliSelect = document.createElement("select");
    cliSelect.className = "loop-step1-cli-select";
    for (const opt of LOOP_CLIS) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (opt === state.cli) o.selected = true;
      cliSelect.appendChild(o);
    }
    on(cliSelect, "change", () => {
      const v = cliSelect.value as LoopCli;
      void dispatch({ kind: "set-cli", cli: v });
    });
    cliWrap.append(cliLbl, cliSelect);

    const spacer = document.createElement("div");
    spacer.className = "loop-step1-toolbar-spacer";

    const consolidate = document.createElement("button");
    consolidate.type = "button";
    consolidate.className = "loop-btn loop-btn-primary loop-step1-consolidate";
    consolidate.textContent = state.consolidating ? "consolidating…" : "✓ consolidate problem.md →";
    const hasTurn = state.turns.length > 0;
    const anyPending = state.turns.some((t) => t.pending);
    consolidate.disabled = !hasTurn || anyPending || state.consolidating;
    if (!hasTurn) {
      consolidate.title = "You need at least one turn before consolidating.";
    } else if (anyPending) {
      consolidate.title = "Wait for the last turn to finish.";
    }
    on(consolidate, "click", () => {
      void dispatch({ kind: "consolidate" });
    });

    toolbar.append(cliWrap, spacer, consolidate);

    let errEl: HTMLElement | null = null;
    if (state.consolidateError) {
      errEl = document.createElement("p");
      errEl.className = "loop-step1-consolidate-error";
      errEl.textContent = `error consolidating: ${state.consolidateError}`;
    }

    const inputRow = document.createElement("form");
    inputRow.className = "loop-step1-input-row";
    inputRow.setAttribute("aria-label", "send message");

    const textarea = document.createElement("textarea");
    textarea.className = "loop-step1-input";
    textarea.placeholder = "describe the problem or reply to the agent… (Cmd+Enter to send)";
    textarea.rows = 4;
    textarea.value = state.inputDraft;
    const inFlight = anyPending || state.consolidating;
    textarea.disabled = inFlight;

    on(textarea, "input", () => {
      void dispatch({ kind: "set-input", value: textarea.value });
    });
    on(textarea, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // Capture the latest textarea value in case the "input" event
        // didn't fire (IME race).
        state.inputDraft = textarea.value;
        void dispatch({ kind: "send" });
      }
    });

    const send = document.createElement("button");
    send.type = "submit";
    send.className = "loop-btn loop-btn-primary loop-step1-send";
    send.textContent = "send";
    send.disabled = inFlight || textarea.value.trim().length === 0;

    on(inputRow, "submit", (e: Event) => {
      e.preventDefault();
      state.inputDraft = textarea.value;
      void dispatch({ kind: "send" });
    });
    // Toggle the button while typing without re-rendering the root.
    on(textarea, "input", () => {
      send.disabled = inFlight || textarea.value.trim().length === 0;
    });

    inputRow.append(textarea, send);

    composer.append(toolbar);
    if (errEl) composer.append(errEl);
    composer.append(inputRow);

    return composer;
  }

  refresh();
  void ctx;

  return { refresh, cleanup };
}

// Step 1 of the agentic flow: problem intake chat.
//
// Overall design (aligned with design.md, decision #3 "one-shot CLI"):
// - Each turn is one-shot: we serialize the entire prior history into the
//   prompt and pass it as `userInput` to `run_loop_agent`. We don't use
//   persistent CLI sessions; that would couple heterogeneous formats (claude
//   JSON vs codex JSONL vs opencode events) and prevent mixing CLIs.
// - The system writes the full draft (`<run>/01-problem-draft.md`) after
//   each turn as auto-save (for resume in Section 9). When the user
//   presses "consolidate", a final turn is invoked asking for the
//   structured summary and persisted to `<run>/01-problem.md`.
// - While the `run_dir` does not exist on disk (first turn), we call
//   `loop_create_run` to initialize it with the prompts copied in.
//
// Follows the "imperative view with re-render via replaceChildren()" pattern
// already used by `loop-chrome.ts`. We don't introduce a framework. The module
// exposes `mountStep1Chat(slot, ctx)` which returns a handle with `dispose()`
// and `getTurnCount()` (useful for the chrome if it wants to show counters in
// the future).

import { invoke } from "@tauri-apps/api/core";

import { stringifyError } from "../../shared/errors";
import { buildRunPromptPath, defaultModelFor, LOOP_CLIS } from "./state/types";
import type { LoopCli, LoopPromptName } from "./state/types";
import { createListenerBag } from "./shared/listener-bag";
import {
  buildConsolidateInstruction,
  buildConsolidatePrompt,
  buildHistoryPrompt,
  looksLikeSessionError,
  parseDraftMarkdown,
  serializeDraftMarkdown,
} from "./step1-chat/prompts";

/** Normalized result from `run_loop_agent`. Mirror of the Rust struct. */
interface AgentResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

/** Paths returned by `loop_create_run`. */
interface CreatedRunPaths {
  runDir: string;
  promptsDir: string;
}

/** A single turn of the conversation: the user's message and the agent's reply. */
export interface ChatTurn {
  user: string;
  /** Empty while the response is in progress. */
  assistant: string;
  /** `true` while the CLI subprocess is running — used to disable the input. */
  pending: boolean;
  /** If the invocation failed, a readable message to display inline. */
  error?: string;
  /** Tokens reported by the CLI, if any. */
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export interface Step1Context {
  /** Absolute path of the active project. Inherited from the workspace via router. */
  projectPath: string;
  /** UUID of the current run. Inherited from the router. */
  runId: string;
  /** Callback on consolidate — the chrome advances to step 2 when it fires. */
  onConsolidate: () => void;
  /**
   * Adopt an existing run: the chrome switches the runId to the given one and
   * optionally jumps to another step. Step 1 invokes this when the user picks
   * a run from the "previous runs" picker.
   */
  onAdoptRun?: (runId: string, step?: 1 | 2 | 3) => void;
}

export interface Step1Handle {
  dispose(): void;
  /** Read the number of completed turns (useful for tests / future views). */
  getTurnCount(): number;
}

/**
 * Mounts the chat inside the given slot (typically `#loop-step-slot`).
 * Re-mounts from scratch: the chrome clears and recreates the slot when the
 * step changes, so the handle only lives while the user is on step 1.
 */
export function mountStep1Chat(slot: HTMLElement, ctx: Step1Context): Step1Handle {
  const state: Step1State = {
    turns: [],
    cli: "claude",
    inputDraft: "",
    consolidating: false,
    consolidatedExists: false,
    sessionByCli: {},
    pickerOpen: false,
    runsList: null,
    pickerLoading: false,
  };

  // The run_dir is created lazily on the first turn — if the user only opens
  // the step and closes the window without saying anything, we don't dirty the
  // FS with an empty dir. Once created, we keep the flag set to avoid the
  // double call (loop_create_run rejects if the dir already exists).
  let runDirReady = false;

  const refs: ViewRefs = render(slot, state, ctx, async (action) => {
    await handleAction(action);
  });

  // Hydrate draft from disk if it exists (partial resume — Section 9 will do
  // the formal resume with state.json; for now if we find a draft, we show a
  // non-destructive "previous draft detected" banner).
  void hydrateDraft();

  async function hydrateDraft(): Promise<void> {
    let touched = false;
    try {
      const draft = await invoke<string>("loop_read_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "01-problem-draft.md",
      });
      if (draft.trim().length > 0) {
        const parsed = parseDraftMarkdown(draft);
        if (parsed.length > 0) {
          state.turns = parsed;
          runDirReady = true;
          touched = true;
        }
      }
    } catch {
      // Run dir doesn't exist yet or the read failed; no draft, no visible error.
    }
    // Detect whether a consolidated `01-problem.md` already exists. Covers two cases:
    //   (a) the user consolidated, navigated to step 2 and came back to step 1.
    //   (b) the user opened an old run (resume) that already had a consolidated file.
    // In both cases we show the "skip to step 2 using the existing problem.md"
    // shortcut so they don't have to redo the chat.
    try {
      const consolidated = await invoke<string>("loop_read_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "01-problem.md",
      });
      if (consolidated.trim().length > 0) {
        state.consolidatedExists = true;
        runDirReady = true;
        touched = true;
      }
    } catch {
      // Same reason as above: no file or run_dir doesn't exist — not an error.
    }
    if (touched) refs.refresh();
  }

  async function handleAction(action: ChatAction): Promise<void> {
    switch (action.kind) {
      case "set-cli":
        state.cli = action.cli;
        refs.refresh();
        return;
      case "set-input":
        state.inputDraft = action.value;
        // No re-render: the input is controlled by the DOM itself; we don't
        // want to repaint while the user is typing. We only refresh on submit/send.
        return;
      case "send":
        await sendTurn();
        return;
      case "consolidate":
        await consolidate();
        return;
      case "skip-to-step-2":
        // Shortcut: the run already has `01-problem.md`. Skip directly to step 2
        // without invoking the consolidator agent again.
        ctx.onConsolidate();
        return;
      case "toggle-picker":
        state.pickerOpen = !state.pickerOpen;
        if (state.pickerOpen && state.runsList === null) {
          state.pickerLoading = true;
          refs.refresh();
          try {
            state.runsList = await invoke<RunSummary[]>("loop_list_runs", {
              projectPath: ctx.projectPath,
            });
          } catch (err) {
            console.error("loop step1: failed to list runs", err);
            state.runsList = [];
          } finally {
            state.pickerLoading = false;
          }
        }
        refs.refresh();
        return;
      case "adopt-run":
        state.pickerOpen = false;
        refs.refresh();
        ctx.onAdoptRun?.(action.runId, action.step);
        return;
      case "edit-system-prompt":
        await editSystemPrompt("problem-intake.md");
        return;
    }
  }

  async function ensureRunDir(): Promise<void> {
    if (runDirReady) return;
    await invoke<CreatedRunPaths>("loop_create_run", {
      projectPath: ctx.projectPath,
      runId: ctx.runId,
    });
    runDirReady = true;
  }

  async function sendTurn(): Promise<void> {
    const userMsg = state.inputDraft.trim();
    if (!userMsg) return;
    if (state.turns.some((t) => t.pending)) return;

    // Optimistic UI: the turn appears as pending.
    const turn: ChatTurn = {
      user: userMsg,
      assistant: "",
      pending: true,
    };
    state.turns.push(turn);
    state.inputDraft = "";
    refs.refresh();

    try {
      await ensureRunDir();
    } catch (err) {
      turn.pending = false;
      turn.error = `failed to create run dir: ${stringifyError(err)}`;
      refs.refresh();
      return;
    }

    // If we have an active session with this CLI, send only the new message —
    // the CLI already remembers the prior turns. Otherwise, serialize the full
    // history into the prompt (legacy one-shot mode, used for bootstrap).
    const sessionId = state.sessionByCli[state.cli];
    const prompt = sessionId ? userMsg : buildHistoryPrompt(state.turns.slice(0, -1), userMsg);

    const systemPromptPath = buildRunPromptPath(ctx.projectPath, ctx.runId, "problem-intake.md");

    try {
      const result = await invoke<AgentResult>("run_loop_agent", {
        cli: state.cli,
        // Default model for step 1 — aligned with design.md ("default with no
        // profile loaded = all claude/opus-4-7"). Per-agent models are
        // configured in Section 6 (Step 3 setup); the intake chat uses the
        // fixed default of the CLI selected in the picker.
        model: defaultModelFor(state.cli),
        cwd: ctx.projectPath,
        systemPromptPath,
        userInput: prompt,
        timeoutSecs: 180,
        sessionId: sessionId ?? null,
      });

      turn.pending = false;
      turn.tokensIn = result.tokensIn ?? null;
      turn.tokensOut = result.tokensOut ?? null;
      if (result.error) {
        turn.error = result.error;
        turn.assistant = result.text ?? "";
        // If the session expired or can't be found, let the next turn
        // bootstrap again with the full history.
        if (looksLikeSessionError(result.error)) {
          delete state.sessionByCli[state.cli];
        }
      } else {
        turn.assistant = result.text;
        if (result.sessionId) {
          state.sessionByCli[state.cli] = result.sessionId;
        }
      }
    } catch (err) {
      turn.pending = false;
      turn.error = stringifyError(err);
    }

    refs.refresh();
    await persistDraft();
  }

  async function persistDraft(): Promise<void> {
    if (!runDirReady) return;
    try {
      await invoke<void>("loop_write_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "01-problem-draft.md",
        content: serializeDraftMarkdown(state.turns),
      });
    } catch (err) {
      // The draft is auto-save; if it fails we don't break the chat — just log.
      console.error("loop step1: failed to save draft", err);
    }
  }

  async function consolidate(): Promise<void> {
    if (state.consolidating) return;
    if (state.turns.length < 1) return;
    if (state.turns.some((t) => t.pending)) return;

    state.consolidating = true;
    refs.refresh();

    try {
      await ensureRunDir();

      // In session mode, the CLI already knows the conversation; the final
      // instruction is enough. Without a session, we send the full history
      // plus the instruction.
      const sessionId = state.sessionByCli[state.cli];
      const prompt = sessionId
        ? buildConsolidateInstruction()
        : buildConsolidatePrompt(state.turns);
      const systemPromptPath = buildRunPromptPath(ctx.projectPath, ctx.runId, "problem-intake.md");

      const result = await invoke<AgentResult>("run_loop_agent", {
        cli: state.cli,
        model: defaultModelFor(state.cli),
        cwd: ctx.projectPath,
        systemPromptPath,
        userInput: prompt,
        timeoutSecs: 180,
        sessionId: sessionId ?? null,
      });

      if (result.error) {
        throw new Error(result.error);
      }

      const finalDoc = result.text.trim();
      if (!finalDoc) {
        throw new Error("empty response from agent");
      }

      await invoke<void>("loop_write_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "01-problem.md",
        content: finalDoc + (finalDoc.endsWith("\n") ? "" : "\n"),
      });

      state.consolidating = false;
      refs.refresh();
      ctx.onConsolidate();
    } catch (err) {
      state.consolidating = false;
      state.consolidateError = stringifyError(err);
      refs.refresh();
    }
  }

  async function editSystemPrompt(name: LoopPromptName): Promise<void> {
    // The prompt's path inside the run (the atomic copy of the global one).
    // If the run_dir hasn't been created yet, create it first so there's a
    // file to open.
    try {
      await ensureRunDir();
    } catch (err) {
      console.error("loop step1: failed to create run for editing prompt", err);
      return;
    }
    const path = buildRunPromptPath(ctx.projectPath, ctx.runId, name);
    try {
      await invoke<void>("open_file_in_editor", { path });
    } catch (err) {
      console.error("loop step1: failed to open editor", err);
    }
  }

  return {
    dispose: () => {
      refs.cleanup();
    },
    getTurnCount: () => state.turns.length,
  };
}

// ---------------------------------------------------------------------------
// Internal state and actions
// ---------------------------------------------------------------------------

interface Step1State {
  turns: ChatTurn[];
  cli: LoopCli;
  inputDraft: string;
  consolidating: boolean;
  consolidateError?: string;
  /** Detected on hydration: a `01-problem.md` with content already exists in the run dir. */
  consolidatedExists: boolean;
  /** Picker open / closed. */
  pickerOpen: boolean;
  /** Runs list loaded from the backend (null = not yet requested or failed). */
  runsList: RunSummary[] | null;
  /** Picker spinner. */
  pickerLoading: boolean;
  /**
   * Session id for each CLI used. Populated with `result.sessionId` after each
   * successful turn and reused on the next turn (claude `--resume`, codex
   * `exec resume`, opencode `--session`). In session mode we only send the new
   * message — the CLI remembers the history. If the CLI changes, we use the
   * new CLI's session (or start a fresh one by sending the full history if we
   * never used that CLI).
   */
  sessionByCli: Partial<Record<LoopCli, string>>;
}

type ChatAction =
  | { kind: "set-cli"; cli: LoopCli }
  | { kind: "set-input"; value: string }
  | { kind: "send" }
  | { kind: "consolidate" }
  | { kind: "skip-to-step-2" }
  | { kind: "toggle-picker" }
  | { kind: "adopt-run"; runId: string; step: 1 | 2 | 3 }
  | { kind: "edit-system-prompt" };

interface RunSummary {
  runId: string;
  lastModifiedMs: number;
  hasDraft: boolean;
  hasConsolidated: boolean;
  hasPhases: boolean;
  preview: string | null;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

interface ViewRefs {
  refresh(): void;
  cleanup(): void;
}

function render(
  slot: HTMLElement,
  state: Step1State,
  ctx: Step1Context,
  dispatch: (action: ChatAction) => void | Promise<void>,
): ViewRefs {
  // The chrome's slot comes with `display: flex; align-items: center` for the
  // placeholders. Switch to a vertical full-height layout for the chat.
  slot.classList.add("loop-step1");

  const root = document.createElement("div");
  root.className = "loop-step1-root";
  slot.replaceChildren(root);

  const listeners = createListenerBag();
  const on = listeners.on;

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
      // Skip the current run — no sense in "adopting" the one you're already using.
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
      // Pick the destination step based on which files exist in the run:
      // if phases are already generated → straight to step 3 (setup), if there
      // is a consolidated file → step 2, if there's only a draft → step 1.
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
    // Autoscroll to the bottom when turns are added. Deferred to the next
    // frame so the DOM is laid out before measuring.
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
    return list;
  }

  function renderTurn(turn: ChatTurn): HTMLElement {
    const block = document.createElement("article");
    block.className = "loop-step1-turn";

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
      // If there was an error, show whatever we have (if anything) plus an
      // error note below. This lets the user see partial responses.
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

    block.append(userRow, agentRow);

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

    // Top row: CLI selector, info, consolidate button
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

    // Consolidation error message, if any
    let errEl: HTMLElement | null = null;
    if (state.consolidateError) {
      errEl = document.createElement("p");
      errEl.className = "loop-step1-consolidate-error";
      errEl.textContent = `error consolidating: ${state.consolidateError}`;
    }

    // Bottom row: textarea + "send" button
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
      // Cmd+Enter / Ctrl+Enter sends. Section 10.3 may unify shortcuts.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // Persist the latest textarea value before submit (in case the
        // "input" event didn't fire due to an IME race).
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
    // Enable/disable the button while typing without re-rendering the root.
    on(textarea, "input", () => {
      send.disabled = inFlight || textarea.value.trim().length === 0;
    });

    inputRow.append(textarea, send);

    composer.append(toolbar);
    if (errEl) composer.append(errEl);
    composer.append(inputRow);

    return composer;
  }

  // Initial render
  refresh();
  // Suppress unused-variable warnings: `ctx` is closed over via dispatch.
  void ctx;

  return { refresh, cleanup };
}

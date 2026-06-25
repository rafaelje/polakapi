// Step 1 of the agentic flow: problem intake chat.
//
// Overall design (aligned with design.md, decision #3 "one-shot CLI"):
// - Each turn is one-shot: we serialize the entire prior history into the
//   prompt and pass it as `userInput` to `run_loop_agent`. We don't use
//   persistent CLI sessions; that would couple heterogeneous formats
//   (claude JSON vs codex JSONL vs opencode events) and prevent mixing
//   CLIs.
// - The system writes the full draft (`<run>/01-problem-draft.md`) after
//   each turn as auto-save (for resume in Section 9). When the user
//   presses "consolidate", a final turn is invoked asking for the
//   structured summary and persisted to `<run>/01-problem.md`.
// - While the `run_dir` does not exist on disk (first turn), we call
//   `loop_create_run` to initialize it with the prompts copied in.
//
// Follows the "imperative view with re-render via replaceChildren()"
// pattern. The renderer lives in `./step1-chat/view.ts`; this file owns
// the state machine and the side effects (agent invocation, draft
// persistence, run-dir bootstrap).

import { invoke } from "@tauri-apps/api/core";

import { stringifyError } from "../../shared/errors";

import { buildRunPromptPath, defaultModelFor } from "./state/types";
import type { LoopPromptName } from "./state/types";
import {
  buildConsolidateInstruction,
  buildConsolidatePrompt,
  buildHistoryPrompt,
  looksLikeSessionError,
  parseDraftMarkdown,
  serializeDraftMarkdown,
} from "./step1-chat/prompts";
import type {
  ChatAction,
  ChatTurn,
  RunSummary,
  Step1Context,
  Step1State,
  ViewRefs,
} from "./step1-chat/state";
import { renderView } from "./step1-chat/view";

export type { ChatTurn, Step1Context } from "./step1-chat/state";

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

export interface Step1Handle {
  dispose(): void;
  /** Read the number of completed turns (useful for tests / future views). */
  getTurnCount(): number;
}

/**
 * Mounts the chat inside the given slot (typically `#loop-step-slot`).
 * Re-mounts from scratch: the chrome clears and recreates the slot when
 * the step changes, so the handle only lives while the user is on step 1.
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

  // The run_dir is created lazily on the first turn — if the user only
  // opens the step and closes the window without saying anything, we
  // don't dirty the FS with an empty dir. Once created, we keep the flag
  // set to avoid the double call (loop_create_run rejects if the dir
  // already exists).
  let runDirReady = false;

  const refs: ViewRefs = renderView(slot, state, ctx, async (action) => {
    await handleAction(action);
  });

  // Hydrate draft from disk if it exists (partial resume — Section 9
  // will do the formal resume with state.json; for now if we find a
  // draft, we show a non-destructive "previous draft detected" banner).
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
      // Run dir doesn't exist yet or the read failed; no draft, no visible
      // error.
    }
    // Detect whether a consolidated `01-problem.md` already exists.
    // Covers two cases:
    //   (a) the user consolidated, navigated to step 2 and came back to step 1.
    //   (b) the user opened an old run (resume) that already had a
    //       consolidated file.
    // In both cases we show the "skip to step 2 using the existing
    // problem.md" shortcut so they don't have to redo the chat.
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
      // Same reason as above: no file or run_dir doesn't exist — not an
      // error.
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
        // No re-render: the input is controlled by the DOM itself; we
        // don't want to repaint while the user is typing. We only
        // refresh on submit/send.
        return;
      case "send":
        await sendTurn();
        return;
      case "consolidate":
        await consolidate();
        return;
      case "skip-to-step-2":
        // Shortcut: the run already has `01-problem.md`. Skip directly
        // to step 2 without invoking the consolidator agent again.
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

    // If we have an active session with this CLI, send only the new
    // message — the CLI already remembers the prior turns. Otherwise,
    // serialize the full history into the prompt (legacy one-shot mode,
    // used for bootstrap).
    const sessionId = state.sessionByCli[state.cli];
    const prompt = sessionId ? userMsg : buildHistoryPrompt(state.turns.slice(0, -1), userMsg);

    const systemPromptPath = buildRunPromptPath(ctx.projectPath, ctx.runId, "problem-intake.md");

    try {
      const result = await invoke<AgentResult>("run_loop_agent", {
        cli: state.cli,
        // Default model for step 1 — aligned with design.md ("default
        // with no profile loaded = all claude/opus-4-7"). Per-agent
        // models are configured in Section 6 (Step 3 setup); the intake
        // chat uses the fixed default of the CLI selected in the picker.
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
      // The draft is auto-save; if it fails we don't break the chat —
      // just log.
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

      // In session mode, the CLI already knows the conversation; the
      // final instruction is enough. Without a session, we send the full
      // history plus the instruction.
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
    // The prompt's path inside the run (the atomic copy of the global
    // one). If the run_dir hasn't been created yet, create it first so
    // there's a file to open.
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

import { invoke } from "@tauri-apps/api/core";

import { stringifyError } from "../../../shared/errors";

import { buildRunPromptPath, defaultModelFor } from "../types";
import type { LoopPromptName } from "../types";
import {
  buildConsolidateInstruction,
  buildConsolidatePrompt,
  buildHistoryPrompt,
  looksLikeSessionError,
  parseDraftMarkdown,
  serializeDraftMarkdown,
} from "./prompts";
import type { ChatAction, ChatTurn, RunSummary, Step1Context, Step1State, ViewRefs } from "./state";
import { renderView } from "./view";

export type { ChatTurn, Step1Context } from "./state";

const AUTO_ANALYZE_PROMPT =
  "Briefly explore the project files in the current working directory and reply with ONE single paragraph, in English, easy to understand. This step is RESEARCH AND ANALYSIS ONLY: cover what the project does (scope), any obvious strengths, and any weaknesses, risks, or ambiguities you notice. Do NOT propose solutions, fixes, architectures, libraries, or implementation steps — solving is for later steps. Do not ask any questions yet — only the analytical paragraph.";

/**
 * Appended to every user turn in step 1. The system prompt is only sent on
 * the first turn of a CLI session, so an existing session that started before
 * the rules were tightened would otherwise keep proposing solutions. This
 * per-turn reminder reinforces the no-solving rule on every turn.
 */
const STEP1_GUARDRAIL =
  "\n\n---\n[step 1 reminder — RESEARCH AND ANALYSIS ONLY: do NOT propose solutions, fixes, implementations, architectures, libraries, patterns, file layouts, APIs, or plans. Your job is to clarify scope, surface weaknesses, highlight strengths, and ask precise technical questions. If you are tempted to propose a solution, ask a clarifying question instead.]";

interface AgentResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

interface CreatedRunPaths {
  runDir: string;
  promptsDir: string;
}

export interface Step1Handle {
  dispose(): void;
  getTurnCount(): number;
}

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

  // The run_dir is created lazily on the first turn so opening and closing
  // the step without input doesn't dirty the FS. The flag also prevents a
  // second loop_create_run, which rejects if the dir already exists.
  let runDirReady = false;
  let disposed = false;

  const refs: ViewRefs = renderView(slot, state, ctx, async (action) => {
    await handleAction(action);
  });

  void hydrateDraft();

  async function hydrateDraft(): Promise<void> {
    let touched = false;
    try {
      const draft = await invoke<string>("loop_read_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "01-problem-draft.md",
      });
      if (disposed) return;
      if (draft.trim().length > 0) {
        const parsed = parseDraftMarkdown(draft);
        if (parsed.length > 0) {
          state.turns = parsed;
          runDirReady = true;
          touched = true;
        }
      }
    } catch {
      // Run dir doesn't exist yet or the read failed; no draft.
    }
    if (disposed) return;
    try {
      const consolidated = await invoke<string>("loop_read_run_file", {
        projectPath: ctx.projectPath,
        runId: ctx.runId,
        file: "01-problem.md",
      });
      if (disposed) return;
      if (consolidated.trim().length > 0) {
        state.consolidatedExists = true;
        runDirReady = true;
        touched = true;
      }
    } catch {
      // No file or run_dir doesn't exist — not an error.
    }
    if (disposed) return;
    if (touched) refs.refresh();
    if (state.turns.length === 0 && !state.consolidatedExists) {
      await autoAnalyzeProject();
    }
  }

  async function autoAnalyzeProject(): Promise<void> {
    if (disposed) return;
    if (state.turns.length > 0 || state.consolidatedExists) return;
    state.inputDraft = AUTO_ANALYZE_PROMPT;
    await sendTurn({ intro: true });
  }

  async function handleAction(action: ChatAction): Promise<void> {
    switch (action.kind) {
      case "set-cli":
        state.cli = action.cli;
        refs.refresh();
        return;
      case "set-input":
        state.inputDraft = action.value;
        // No re-render: the input is controlled by the DOM; repainting
        // while typing would clobber the caret. Refresh only on send.
        return;
      case "send":
        await sendTurn();
        return;
      case "consolidate":
        await consolidate();
        return;
      case "skip-to-step-2":
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
    // Per-run prompts are seeded lazily — step 1 only needs problem-intake.md.
    await invoke<void>("loop_ensure_run_prompt", {
      projectPath: ctx.projectPath,
      runId: ctx.runId,
      name: "problem-intake.md",
    });
    runDirReady = true;
  }

  async function sendTurn(opts?: { intro?: boolean }): Promise<void> {
    const userMsg = state.inputDraft.trim();
    if (!userMsg) return;
    if (state.turns.some((t) => t.pending)) return;

    const turn: ChatTurn = {
      user: userMsg,
      assistant: "",
      pending: true,
      intro: opts?.intro,
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

    // With an active session for this CLI, send only the new message —
    // the CLI already remembers prior turns. Otherwise serialize the full
    // history into the prompt to bootstrap. Either way we append the
    // step-1 guardrail so the no-solving rule is reinforced every turn.
    const sessionId = state.sessionByCli[state.cli];
    const baseUserMsg = userMsg + STEP1_GUARDRAIL;
    const prompt = sessionId
      ? baseUserMsg
      : buildHistoryPrompt(state.turns.slice(0, -1), baseUserMsg);

    const systemPromptPath = buildRunPromptPath(ctx.projectPath, ctx.runId, "problem-intake.md");

    try {
      const result = await invoke<AgentResult>("run_loop_agent", {
        cli: state.cli,
        // Intake chat uses the CLI's fixed default; per-agent models are
        // configured later in step 3 setup.
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
        // If the session expired or is missing, clear it so the next turn
        // bootstraps again with the full history.
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
      // Draft is auto-save; a failure must not break the chat.
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

      // In session mode the CLI already has the conversation; otherwise
      // we resend the full history with the instruction.
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
    // The editor needs a file on disk; bootstrap the run_dir first so the
    // per-run copy of the prompt exists.
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
      disposed = true;
      refs.cleanup();
    },
    getTurnCount: () => state.turns.length,
  };
}

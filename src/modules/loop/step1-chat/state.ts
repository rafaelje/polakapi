// Internal state + actions + run-summary shape for step 1 chat. Lives in
// its own module so the renderer (view.ts) can import them without going
// through the main mount file.

import type { LoopCli } from "../state/types";

/** A single turn of the conversation: user message + agent reply. */
export interface ChatTurn {
  user: string;
  /** Empty while the response is in progress. */
  assistant: string;
  /** `true` while the CLI subprocess is running — disables the input. */
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
   * Adopt an existing run: the chrome switches the runId to the given one
   * and optionally jumps to another step. Step 1 invokes this when the
   * user picks a run from the "previous runs" picker.
   */
  onAdoptRun?: (runId: string, step?: 1 | 2 | 3) => void;
}

export interface Step1State {
  turns: ChatTurn[];
  cli: LoopCli;
  inputDraft: string;
  consolidating: boolean;
  consolidateError?: string;
  /** A `01-problem.md` with content already exists in the run dir. */
  consolidatedExists: boolean;
  /** Picker open / closed. */
  pickerOpen: boolean;
  /** Runs list loaded from the backend (null = not yet requested or failed). */
  runsList: RunSummary[] | null;
  /** Picker spinner. */
  pickerLoading: boolean;
  /**
   * Session id for each CLI used. Populated with `result.sessionId` after
   * each successful turn and reused on the next turn (claude `--resume`,
   * codex `exec resume`, opencode `--session`). In session mode we only
   * send the new message — the CLI remembers the history. If the CLI
   * changes, we use the new CLI's session (or start a fresh one by
   * sending the full history if we never used that CLI).
   */
  sessionByCli: Partial<Record<LoopCli, string>>;
}

export type ChatAction =
  | { kind: "set-cli"; cli: LoopCli }
  | { kind: "set-input"; value: string }
  | { kind: "send" }
  | { kind: "consolidate" }
  | { kind: "skip-to-step-2" }
  | { kind: "toggle-picker" }
  | { kind: "adopt-run"; runId: string; step: 1 | 2 | 3 }
  | { kind: "edit-system-prompt" };

export interface RunSummary {
  runId: string;
  lastModifiedMs: number;
  hasDraft: boolean;
  hasConsolidated: boolean;
  hasPhases: boolean;
  preview: string | null;
}

export interface ViewRefs {
  refresh(): void;
  cleanup(): void;
}

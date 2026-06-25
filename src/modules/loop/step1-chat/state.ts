import type { LoopCli } from "../types";

export interface ChatTurn {
  user: string;
  assistant: string;
  pending: boolean;
  error?: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export interface Step1Context {
  projectPath: string;
  runId: string;
  onConsolidate: () => void;
  onAdoptRun?: (runId: string, step?: 1 | 2 | 3) => void;
}

export interface Step1State {
  turns: ChatTurn[];
  cli: LoopCli;
  inputDraft: string;
  consolidating: boolean;
  consolidateError?: string;
  consolidatedExists: boolean;
  pickerOpen: boolean;
  /** null = not yet requested or failed. */
  runsList: RunSummary[] | null;
  pickerLoading: boolean;
  /**
   * Session id per CLI. Reused on the next turn (claude `--resume`, codex
   * `exec resume`, opencode `--session`) so we only need to send the new
   * message. When switching CLIs we either reuse that CLI's stored session
   * or bootstrap by sending the full history.
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

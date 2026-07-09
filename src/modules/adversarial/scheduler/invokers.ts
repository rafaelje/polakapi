// Thin wrappers over the Tauri commands used by the debate scheduler. Keeping
// this file boring makes it trivial to mock in tests (see the scheduler tests
// that pass a `DebateInvokers` fake).

import { invoke } from "@tauri-apps/api/core";

import type { AdversarialPromptName, DebateSlot } from "../types";

export interface AgentInvocationResult {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  sessionId: string | null;
  error: string | null;
}

export interface RunAgentArgs {
  cli: string;
  model: string;
  cwd: string;
  runId: string;
  systemPromptPath: string | null;
  userInput: string;
  timeoutSecs: number;
  effort: string | null;
  runDirRoot: ".loop" | ".adversarial";
}

export type DiffMode = "committed" | "working";

export interface BranchDiff {
  baseRef: string;
  mergeBase: string;
  headSha: string;
  diff: string;
  stat: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  truncated: boolean;
  paths: string[];
  mode: DiffMode;
}

export interface DebateInvokers {
  runAgent: (args: RunAgentArgs) => Promise<AgentInvocationResult>;
  detectBaseRef: (projectPath: string) => Promise<string>;
  branchDiff: (
    projectPath: string,
    baseRef: string,
    paths: string[],
    mode: DiffMode,
  ) => Promise<BranchDiff>;
  createRun: (
    projectPath: string,
    runId: string,
  ) => Promise<{ runDir: string; promptsDir: string }>;
  writeRunFile: (
    projectPath: string,
    runId: string,
    file: string,
    content: string,
  ) => Promise<void>;
  readRunFile: (projectPath: string, runId: string, file: string) => Promise<string>;
  writeState: (projectPath: string, runId: string, content: string) => Promise<void>;
  readState: (projectPath: string, runId: string) => Promise<string>;
  ensureRunPrompt: (
    projectPath: string,
    runId: string,
    name: AdversarialPromptName,
  ) => Promise<void>;
  validateCli: (slot: DebateSlot) => Promise<CliValidation>;
}

export interface CliValidation {
  ok: boolean;
  reason?: string | null;
}

export const invokers: DebateInvokers = {
  runAgent: (args) =>
    invoke<AgentInvocationResult>("run_loop_agent", args as unknown as Record<string, unknown>),
  detectBaseRef: (projectPath) => invoke<string>("git_detect_base_ref", { projectPath }),
  branchDiff: (projectPath, baseRef, paths, mode) =>
    invoke<BranchDiff>("git_branch_diff", { projectPath, baseRef, paths, mode }),
  createRun: (projectPath, runId) =>
    invoke<{ runDir: string; promptsDir: string }>("adv_create_run", { projectPath, runId }),
  writeRunFile: (projectPath, runId, file, content) =>
    invoke<void>("adv_write_run_file", { projectPath, runId, file, content }),
  readRunFile: (projectPath, runId, file) =>
    invoke<string>("adv_read_run_file", { projectPath, runId, file }),
  writeState: (projectPath, runId, content) =>
    invoke<void>("adv_write_state_file", { projectPath, runId, content }),
  readState: (projectPath, runId) => invoke<string>("adv_read_state_file", { projectPath, runId }),
  ensureRunPrompt: (projectPath, runId, name) =>
    invoke<void>("adv_ensure_run_prompt", { projectPath, runId, name }),
  validateCli: (slot) =>
    invoke<CliValidation>("loop_validate_cli_model", { cli: slot.cli, model: slot.model }),
};

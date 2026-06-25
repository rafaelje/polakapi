import type { LoopAgentRole, LoopPromptName, ProfileMatrix } from "../../types";

export type AgentStageStatus = "pending" | "running" | "done" | "warning" | "error";

export type SequentialAgent = "analysis" | "implementation" | "review" | "knowledge";

export interface AgentStageState {
  status: AgentStageStatus;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  retries: number;
  message?: string;
}

export interface PhaseState {
  slug: string;
  id: string;
  name: string;
  status: AgentStageStatus;
  stages: Record<SequentialAgent, AgentStageState>;
  reviewerExhausted: boolean;
}

export interface RunSettings {
  projectPath: string;
  runId: string;
  matrix: ProfileMatrix;
  promptOverrides: Partial<Record<LoopPromptName, string>>;
  maxRetries: number;
  agentTimeoutSecs: number;
}

export type SchedulerMode = "sequential" | "hybrid";

export type RunStatus = "idle" | "running" | "paused" | "completed" | "aborted" | "error";

export type IntegratorStatus = "pending" | "running" | "done" | "conflict" | "error";

export interface IntegratorState {
  batchId: string;
  batchIndex: number;
  status: IntegratorStatus;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  conflicts: string[];
  message?: string;
}

export interface RunSchedulerState {
  status: RunStatus;
  mode: SchedulerMode;
  phases: PhaseState[];
  batches: string[][];
  integrators: IntegratorState[];
  currentPhaseIndex: number;
  currentBatchIndex: number;
  currentStage: SequentialAgent | null;
  totals: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  byAgent: Record<LoopAgentRole, { tokensIn: number; tokensOut: number; costUsd: number }>;
  message: string | null;
  lastHeartbeat: number;
  settings: RunSettings | null;
}

export type RunSchedulerListener = (state: RunSchedulerState) => void;

export type ConflictDecision = "continue" | "abort" | "rerun";

export interface AgentResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

export interface SchedulerInvokers {
  runAgent(args: {
    cli: string;
    model: string;
    cwd: string;
    systemPromptPath: string | null;
    userInput: string;
    timeoutSecs: number;
  }): Promise<AgentResult>;
  readOutput(args: {
    projectPath: string;
    runId: string;
    phaseSlug: string;
    agent: SequentialAgent;
    ext: "md" | "diff";
  }): Promise<string>;
  writeOutput(args: {
    projectPath: string;
    runId: string;
    phaseSlug: string;
    agent: SequentialAgent;
    ext: "md" | "diff";
    content: string;
  }): Promise<void>;
  writeState(args: { projectPath: string; runId: string; content: string }): Promise<void>;
  gitDiffSnapshot(args: { projectPath: string }): Promise<string>;
  readPhaseFile(args: {
    projectPath: string;
    runId: string;
    phaseSlug: string;
    file: "logic.md" | "visual.html";
  }): Promise<string>;
  readBatchFile(args: {
    projectPath: string;
    runId: string;
    batchId: string;
    file: "knowledge.md";
  }): Promise<string>;
  writeBatchFile(args: {
    projectPath: string;
    runId: string;
    batchId: string;
    file: "knowledge.md";
    content: string;
  }): Promise<void>;
}

export interface BatchConflict {
  path: string;
  phases: string[];
}

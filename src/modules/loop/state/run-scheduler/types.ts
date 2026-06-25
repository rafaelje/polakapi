// Public type surface of the run scheduler. Lives in its own module so the
// state-factories, invokers, and helper files can import these without
// going through the heavy `run-scheduler.ts` (which would create a cycle
// since the class itself imports each of the helper files).

import type { LoopAgentRole, LoopPromptName, ProfileMatrix } from "../types";

/**
 * Status of a stage (= one agent) within a phase. Same semantics as the
 * pattern used in the design doc ("pending/running/done/warning").
 *
 * - `pending` : its turn has not come yet. Default when state is created.
 * - `running` : the subprocess is in progress. Set before `invoke` and
 *               cleared upon receiving the response.
 * - `done`    : finished OK and persisted its output.
 * - `warning` : completed with a caveat (e.g. reviewer did not approve,
 *               knowledge received the debt). The run continues.
 * - `error`   : failed unrecoverably (e.g. timeout, CLI did not return
 *               parseable JSON). The run is paused until the user decides
 *               — design decision #4 only covers "reviewer", not CLI
 *               infrastructure errors.
 */
export type AgentStageStatus = "pending" | "running" | "done" | "warning" | "error";

/** The 4 stages of the sequential pipeline — the integrator (5th agent) only in hybrid. */
export type SequentialAgent = "analysis" | "implementation" | "review" | "knowledge";

/** State of each agent within a phase. */
export interface AgentStageState {
  status: AgentStageStatus;
  /** Tokens consumed so far (includes the sum of reviewer retries). */
  tokensIn: number;
  tokensOut: number;
  /** USD cost reported by the CLI, if exposed. */
  costUsd: number;
  /** Number of reviewer retries consumed in this phase (only applies to the reviewer). */
  retries: number;
  /** Human-readable message if the status is `warning` or `error`. */
  message?: string;
}

/** State of a phase of the run. */
export interface PhaseState {
  slug: string;
  id: string;
  name: string;
  /** Aggregate status: derived from the 4 stages but precomputed for the view. */
  status: AgentStageStatus;
  /** Per-stage: analysis, implementation, review, knowledge. */
  stages: Record<SequentialAgent, AgentStageState>;
  /** Set when the reviewer hit the cap of 3 without approving. Persisted in knowledge. */
  reviewerExhausted: boolean;
}

/** Immutable run configuration, snapshotted at execution time. */
export interface RunSettings {
  projectPath: string;
  runId: string;
  matrix: ProfileMatrix;
  /** Per-name prompt override (what the user edited in setup). */
  promptOverrides: Partial<Record<LoopPromptName, string>>;
  /** Reviewer cap — design decision #4 fixes 3 but we leave it parametrizable for tests. */
  maxRetries: number;
  /** Timeout per agent invocation (seconds). 300s default; setup does not expose it yet. */
  agentTimeoutSecs: number;
}

/** Scheduler execution mode. `hybrid` runs phases in batches + integrator. */
export type SchedulerMode = "sequential" | "hybrid";

/** Global run status. */
export type RunStatus =
  | "idle" // created but not started
  | "running" // processing a phase
  | "paused" // pause requested and applied
  | "completed" // all phases done/warning
  | "aborted" // the user aborted
  | "error"; // an unexpected error stopped the run

/**
 * State of the integrator (5th agent) between batches in hybrid mode. Each
 * batch has its own integrator that runs after ALL the phases of the batch
 * finish. Sections 8.3/8.4 give it the role of consolidating knowledge +
 * detecting conflicts.
 *
 * - `pending`: the batch has not finished yet.
 * - `running`: the integrator is running.
 * - `done`: finished OK, no conflicts. The consolidated knowledge lives in
 *           `<run>/outputs/batches/<batchId>/knowledge.md` and is passed to
 *           the next batch as additional input (Section 8.6).
 * - `conflict`: the integrator detected conflicts (`INTEGRATION: blocker`
 *               in its output, or structural detection via diff overlap).
 *               The run is paused and the user decides (continue / abort /
 *               re-run).
 * - `error`: integrator invocation error.
 */
export type IntegratorStatus = "pending" | "running" | "done" | "conflict" | "error";

/** Integrator state for a specific batch. */
export interface IntegratorState {
  /** Batch ID: `batch-0`, `batch-1`, ... — used as path in outputs. */
  batchId: string;
  /** Ordinal batch index (0-based). */
  batchIndex: number;
  status: IntegratorStatus;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /**
   * List of conflicting paths if `status === "conflict"`. Useful so the UI
   * can show exactly which files break (Section 8.5).
   */
  conflicts: string[];
  /** Human-readable message if `conflict`/`error`. */
  message?: string;
}

/** Full snapshot of the scheduler state. */
export interface RunSchedulerState {
  status: RunStatus;
  mode: SchedulerMode;
  /** Phases in execution order (flattened in sequential; ordered by batch in hybrid). */
  phases: PhaseState[];
  /**
   * Batches of the DAG when `mode === "hybrid"`. Each entry lists the
   * `slug`s of the phases that run in parallel in that batch. In
   * sequential mode this array is empty. Section 8.7 uses it for the
   * batch view.
   */
  batches: string[][];
  /** Per-batch integrator state. Empty in sequential mode. */
  integrators: IntegratorState[];
  /** Index of the phase being processed (or the last one that finished). */
  currentPhaseIndex: number;
  /** Index of the current batch in hybrid mode. -1 before starting. */
  currentBatchIndex: number;
  /** Stage being processed within the current phase. null between phases. */
  currentStage: SequentialAgent | null;
  /** Accumulated tokens and USD to show in the view header. */
  totals: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  /** Per-agent accumulated (full role, including integration). */
  byAgent: Record<LoopAgentRole, { tokensIn: number; tokensOut: number; costUsd: number }>;
  /** Global message (last error, "pause requested", etc.). */
  message: string | null;
  /** Heartbeat — ms epoch, updated after each state.json persist. */
  lastHeartbeat: number;
  /** Immutable run settings (snapshot at startup time). */
  settings: RunSettings | null;
}

export type RunSchedulerListener = (state: RunSchedulerState) => void;

/**
 * User decision on receiving the conflict report from the integrator
 * (Section 8.5). The UI calls `scheduler.resolveConflict(decision)`.
 */
export type ConflictDecision = "continue" | "abort" | "rerun";

/** Result of `run_loop_agent` mirrored from the backend (camelCase). */
export interface AgentResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

/**
 * Hooks for tests / debugging. In production, every invocation goes
 * through `invoke()` from `@tauri-apps/api`. In tests we pass an
 * alternative harness that returns deterministic results.
 */
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
  /** Section 8: read/write of the consolidated knowledge per batch. */
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

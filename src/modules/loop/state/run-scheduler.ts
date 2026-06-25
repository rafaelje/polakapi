// Step 3 engine: scheduler that orchestrates the per-phase pipeline.
//
// Overall design (aligned with design.md decision #1 "contract via files on
// disk" and #4 "reviewer cap at 3"):
//
// - The run consists of N phases (from `02-phases.md`).
//   - In `sequential` mode we process them in the topological order returned
//     by `topologicalBatches` — flattened to a linear list because each phase
//     has its deps satisfied by the time its turn comes.
//   - In `hybrid` mode (Section 8) we process them in batches: each batch
//     runs its phases in parallel (`Promise.all`), and between batches the
//     integrator agent (5th agent) runs, consolidating knowledge and
//     detecting FS conflicts. If the integrator marks a blocker or the
//     scheduler detects paths touched by multiple phases, the run pauses
//     waiting for a user decision (continue / re-run / abort).
//
// - Per-phase pipeline: analysis → implementation → review (≤ 3 tries) →
//   knowledge. Each step:
//     1. snapshot the current project diff ("before" the agent);
//     2. invoke run_loop_agent with the CLI/model of the configured slot and
//        the agent prompt (from `<run>/prompts/<agent>.md`);
//     3. persist `outputs/<phase>/<agent>.md` with result.text;
//     4. snapshot the diff again ("after") and diff_post - diff_pre is saved
//        as `outputs/<phase>/<agent>.diff` (what the agent changed in the FS).
//     5. accumulate tokens/cost in the run budget and persist `state.json`
//        with `lastHeartbeat`.
//
// - Reviewer cap: if after the 3rd retry the reviewer has not approved, we
//   mark the phase as `warning` and inject an additional input into
//   `knowledge` with the debt. The run continues — design decision #4.
//
// - The module exposes `class RunScheduler` with a pattern consistent with
//   `LoopRouter` (listeners + getState + start/pause/abort commands). It
//   does NOT mount UI — the view layer (Section 7.7) consumes `getState()`
//   and subscribes via `on()`. Keeps parity with
//   `src/modules/workspaces/state/workspaces-controller.ts`.
//
// - Pause: no kill mid-agent — the CLI subprocess keeps running until it
//   finishes (we have no kill from the current wrapper; see loop_cli.rs
//   gotcha "kill of a hung subprocess"). When the current agent ends, the
//   scheduler sees `pauseRequested=true` and stops before the next.
//
// - Abort: marks `aborted` and leaves everything as-is. The user can resume
//   in Section 9 (resume). It does NOT delete already-persisted outputs —
//   they are auditable.

import { invoke } from "@tauri-apps/api/core";

import { topologicalBatches, type Phase } from "../step2-phases";
import { buildPersistedRunState, type PersistedRunState } from "./state-schema";
import type { AgentSlot, LoopAgentRole, LoopPromptName, ProfileMatrix } from "./types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
 *               parseable JSON). The run is paused until the user decides —
 *               design decision #4 only covers "reviewer", not CLI
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
 * - `conflict`: the integrator detected conflicts (`INTEGRATION: blocker` in
 *               its output, or structural detection via diff overlap). The
 *               run is paused and the user decides (continue / abort / re-run).
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
   * Batches of the DAG when `mode === "hybrid"`. Each entry lists the `slug`s
   * of the phases that run in parallel in that batch. In sequential mode this
   * array is empty. Section 8.7 uses it for the batch view.
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
interface AgentResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

const SEQUENTIAL_AGENTS: readonly SequentialAgent[] = [
  "analysis",
  "implementation",
  "review",
  "knowledge",
] as const;

const ALL_AGENT_ROLES: readonly LoopAgentRole[] = [
  "analysis",
  "implementation",
  "review",
  "knowledge",
  "integration",
] as const;

function createEmptyStage(): AgentStageState {
  return {
    status: "pending",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    retries: 0,
  };
}

function createPhaseState(phase: Phase, slug: string): PhaseState {
  return {
    slug,
    id: phase.id,
    name: phase.name,
    status: "pending",
    stages: {
      analysis: createEmptyStage(),
      implementation: createEmptyStage(),
      review: createEmptyStage(),
      knowledge: createEmptyStage(),
    },
    reviewerExhausted: false,
  };
}

function createInitialState(): RunSchedulerState {
  return {
    status: "idle",
    mode: "sequential",
    phases: [],
    batches: [],
    integrators: [],
    currentPhaseIndex: -1,
    currentBatchIndex: -1,
    currentStage: null,
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    byAgent: {
      analysis: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      implementation: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      review: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      knowledge: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      integration: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    },
    message: null,
    lastHeartbeat: 0,
    settings: null,
  };
}

function createIntegratorState(batchIndex: number): IntegratorState {
  return {
    batchId: batchIdFor(batchIndex),
    batchIndex,
    status: "pending",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    conflicts: [],
  };
}

/** Deterministic batch ID. We use it as `batchId` for outputs. */
export function batchIdFor(index: number): string {
  return `batch-${index}`;
}

/**
 * Orders phases linearly respecting the DAG. Reuses `topologicalBatches`
 * from step 2 — if the whole DAG is linear each batch has 1 phase and the
 * flatten is exact. If there are parallel branches, we process them in batch
 * order (the internal order doesn't matter because their deps are in
 * previous batches).
 */
export function sequentialPhaseOrder(phases: Phase[]): Phase[] | null {
  const batches = topologicalBatches(phases);
  if (!batches) return null;
  return batches.flat();
}

/** Slug matches step 2 — duplicated by inverse dependency. */
export function phaseToSlug(phase: Phase): string {
  const safeName = phase.name.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${phase.id}-${safeName}`;
}

// ---------------------------------------------------------------------------
// Scheduler class
// ---------------------------------------------------------------------------

/**
 * Hooks for tests / debugging. In production, every invocation goes through
 * `invoke()` from `@tauri-apps/api`. In future tests (Section 11) we can
 * pass an alternative harness that returns deterministic results.
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
  /**
   * The run prompt path (`<run>/prompts/<name>`). We derive it at the caller
   * with `buildRunPromptPath` (below).
   */
}

/** Default implementation via Tauri. */
const defaultInvokers: SchedulerInvokers = {
  runAgent: (args) => invoke<AgentResult>("run_loop_agent", args),
  readOutput: (args) => invoke<string>("loop_read_output_file", args),
  writeOutput: (args) => invoke<void>("loop_write_output_file", args),
  writeState: (args) => invoke<void>("loop_write_state_file", args),
  gitDiffSnapshot: (args) => invoke<string>("loop_git_diff_snapshot", args),
  readPhaseFile: (args) => invoke<string>("loop_read_phase_file", args),
  readBatchFile: (args) => invoke<string>("loop_read_batch_file", args),
  writeBatchFile: (args) => invoke<void>("loop_write_batch_file", args),
};

export class RunScheduler {
  private state: RunSchedulerState = createInitialState();
  private readonly listeners = new Set<RunSchedulerListener>();
  private readonly invokers: SchedulerInvokers;
  /**
   * Internal flag that the main loop checks between stages. When `true` we
   * stop the scheduler before launching the next agent. It does NOT kill
   * subprocesses in progress — for that we would need to hook the child PID
   * in the Rust wrapper, which is not currently exposed.
   */
  private pauseRequested = false;
  private abortRequested = false;
  /** Promise of the main cycle — for external await. */
  private cycle: Promise<void> | null = null;
  /**
   * Section 9.3 — heartbeat timer. We start it on entering a stage (running)
   * and stop it when the stage ends (or when the scheduler stops). Updates
   * `lastHeartbeat` every `heartbeatIntervalMs` so the "interrupted runs"
   * detector can distinguish a live process from a dead one. Default 5s —
   * design.md "Open Questions" leaves that value.
   */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = 5000;

  constructor(invokers: SchedulerInvokers = defaultInvokers) {
    this.invokers = invokers;
  }

  getState(): RunSchedulerState {
    return this.state;
  }

  on(listener: RunSchedulerListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /**
   * Initializes the scheduler with an ordered set of phases + settings,
   * without starting execution. Useful for showing the initial view with
   * everything `pending`. `mode` defaults to `"sequential"` for compatibility
   * with call-sites prior to Section 8.
   *
   * In `"hybrid"` mode:
   * - We compute batches with `topologicalBatches` (Kahn, Section 8.1).
   * - Each batch generates its entry in `state.integrators`.
   * - Phases are ordered by batch (preserving the internal Kahn order) so
   *   that `currentPhaseIndex` still makes sense in the flat view.
   */
  initialize(phases: Phase[], settings: RunSettings, mode: SchedulerMode = "sequential"): void {
    const batchesByPhase = topologicalBatches(phases);
    if (!batchesByPhase) {
      this.commit({
        ...createInitialState(),
        status: "error",
        message: "there is a cycle in the dependencies — cannot execute",
        settings,
      });
      return;
    }
    const ordered = batchesByPhase.flat();
    const phaseStates = ordered.map((p) => createPhaseState(p, phaseToSlug(p)));

    // Batch -> slugs mapping (only populated in hybrid mode; the sequential
    // view ignores it).
    const batches: string[][] =
      mode === "hybrid" ? batchesByPhase.map((batch) => batch.map((p) => phaseToSlug(p))) : [];
    const integrators: IntegratorState[] =
      mode === "hybrid" ? batches.map((_, i) => createIntegratorState(i)) : [];

    this.pauseRequested = false;
    this.abortRequested = false;
    this.conflictResolver = null;
    this.commit({
      ...createInitialState(),
      mode,
      phases: phaseStates,
      batches,
      integrators,
      settings,
      // In hybrid mode we start at batchIndex 0; in sequential it stays at -1.
      currentBatchIndex: mode === "hybrid" ? 0 : -1,
      lastHeartbeat: Date.now(),
    });
  }

  /**
   * Starts the main scheduler cycle. Resolves when the run ends
   * (completed/aborted/error/paused).
   */
  async start(): Promise<void> {
    if (this.state.status === "running") return;
    if (!this.state.settings) {
      this.commit({
        ...this.state,
        status: "error",
        message: "scheduler without settings — call initialize() first",
      });
      return;
    }
    this.pauseRequested = false;
    this.abortRequested = false;
    this.commit({ ...this.state, status: "running", message: null });
    this.cycle = this.runCycle().catch((err: unknown) => {
      this.commit({
        ...this.state,
        status: "error",
        message: `unexpected error: ${stringifyError(err)}`,
      });
    });
    await this.cycle;
  }

  /**
   * Requests a cooperative pause. The current agent finishes; before the
   * next one the scheduler checks the flag and stops.
   */
  pause(): void {
    if (this.state.status !== "running") return;
    this.pauseRequested = true;
    this.commit({ ...this.state, message: "pause requested — current agent will finish" });
  }

  /**
   * Aborts the run. Same behavior as pause regarding the current agent, but
   * upon stopping the status remains `aborted` and it cannot be resumed
   * without a new `start()`.
   */
  abort(): void {
    if (this.state.status !== "running" && this.state.status !== "paused") return;
    this.abortRequested = true;
    this.pauseRequested = true;
    this.commit({ ...this.state, message: "abort requested — current agent will finish" });
    // If we are waiting on a conflict decision (Section 8.5), we unblock the
    // await with "abort" so the main cycle can exit.
    if (this.conflictResolver) {
      const resolver = this.conflictResolver;
      this.conflictResolver = null;
      resolver("abort");
    }
    // The heartbeat timer is stopped in `finalizeCycle()` when the current
    // agent finishes; we leave it alive until then so the run keeps reporting
    // as "alive" to the interrupted-runs detector.
  }

  /**
   * Section 8.5: the integrator detected a conflict and the run is paused.
   * The user must decide via `resolveConflict()`. The promise the main cycle
   * `await`s is left hanging until then.
   *
   * - `continue`: accept the batch as-is and move on to the next.
   * - `abort`: cut the run short.
   * - `rerun`: re-run the whole batch (all batch phases go back to `pending`
   *   and are relaunched).
   */
  private conflictResolver: ((decision: ConflictDecision) => void) | null = null;

  /**
   * The user resolves a conflict reported by the integrator. No-op if there
   * is no active conflict (status !== "paused" by integrator).
   */
  resolveConflict(decision: ConflictDecision): void {
    if (!this.conflictResolver) return;
    const resolver = this.conflictResolver;
    this.conflictResolver = null;
    resolver(decision);
  }

  // -------------------------------------------------------------------------
  // Main cycle — dispatch between sequential and hybrid mode
  // -------------------------------------------------------------------------

  private async runCycle(): Promise<void> {
    if (this.state.mode === "hybrid") {
      await this.runHybridCycle();
    } else {
      await this.runSequentialCycle();
    }
  }

  private async runSequentialCycle(): Promise<void> {
    const startIndex = Math.max(0, this.state.currentPhaseIndex);
    for (let i = startIndex; i < this.state.phases.length; i++) {
      if (this.shouldStop()) break;
      this.updatePhaseIndex(i);
      await this.runPhase(i);
    }
    this.finalizeCycle();
    await this.persistState();
  }

  /**
   * Section 8: hybrid mode cycle.
   *
   * For each batch:
   *   1. Launch all phases of the batch in parallel (`Promise.all` over
   *      `runPhase` — section 8.2). The internal pipeline of each phase
   *      (analysis → impl → review → knowledge) runs independently. Since
   *      the contract between agents is via files on disk (design decision
   *      #1) and each phase writes to its own `phases/<slug>/`, there is
   *      no intra-batch coupling.
   *   2. Wait for the batch phases to finish (ok, warning, or error).
   *   3. Detect FS conflicts between the batch phases (section 8.4): parse
   *      the implementation `*.diff`s and check whether two phases touch
   *      the same path.
   *   4. Run the integrator (5th agent) over the batch outputs (section
   *      8.3). Output goes to `<run>/outputs/batches/batch-N/knowledge.md`.
   *   5. If the integrator or the structural detector mark conflict, pause
   *      until the user decides (section 8.5).
   *
   * The consolidated knowledge of batch N becomes available to the phases
   * of batch N+1 via `buildAgentInput`, which reads it from disk (section 8.6).
   */
  private async runHybridCycle(): Promise<void> {
    let batchIndex = Math.max(0, this.state.currentBatchIndex);
    while (batchIndex < this.state.batches.length) {
      if (this.shouldStop()) break;
      this.commit({ ...this.state, currentBatchIndex: batchIndex });

      // 1. Launch the batch phases in parallel.
      const slugs = this.state.batches[batchIndex];
      const phaseIndices = slugs
        .map((slug) => this.state.phases.findIndex((p) => p.slug === slug))
        .filter((i) => i >= 0);
      if (phaseIndices.length === 0) {
        batchIndex += 1;
        continue;
      }

      // Reset of retries/status only when the batch starts clean (not resume).
      // The formal resume (Section 9) may preserve done stages; here if the
      // batch starts, all its phases must be pending (they are on
      // initialize) or reset (on re-run via `resolveConflict("rerun")`).

      await Promise.all(phaseIndices.map((idx) => this.runPhase(idx)));

      if (this.shouldStop()) break;
      // If any batch phase ended in fatal `error`, we don't run the integrator
      // and leave the run in error.
      const anyError = phaseIndices.some((i) => this.state.phases[i].status === "error");
      if (anyError || this.state.status === "error") {
        // runPhase already set the message in that case.
        break;
      }

      // 2. Run integrator. Returns detected conflicts (structural ones +
      //    those the agent marked with `INTEGRATION: blocker`).
      const integratorOutcome = await this.runIntegrator(batchIndex, phaseIndices);
      if (this.shouldStop()) break;
      if (integratorOutcome === "error") {
        // We mark the run in error and let the user inspect the state.
        this.commit({
          ...this.state,
          status: "error",
          message: `integrator batch-${batchIndex} failed — see outputs/batches/${batchIdFor(batchIndex)}/`,
        });
        break;
      }

      if (integratorOutcome === "conflict") {
        // 3. Conflict: pause and wait for the user. The decision arrives via
        //    `resolveConflict()` (Section 8.5).
        const decision = await this.awaitConflictDecision(batchIndex);
        if (decision === "abort") {
          this.abortRequested = true;
          break;
        }
        if (decision === "rerun") {
          this.resetBatchPhases(phaseIndices);
          this.patchIntegrator(batchIndex, {
            status: "pending",
            conflicts: [],
            message: undefined,
          });
          this.commit({ ...this.state, status: "running", message: null });
          // Continue the while loop with the same batchIndex.
          continue;
        }
        // decision === "continue": treat the integrator as done and advance.
        this.patchIntegrator(batchIndex, {
          status: "done",
          message: "conflicts accepted by the user — the flow continues",
        });
        this.commit({ ...this.state, status: "running", message: null });
      }

      batchIndex += 1;
    }
    this.finalizeCycle();
    await this.persistState();
  }

  /**
   * Closing of the main cycle (common to sequential/hybrid). Decides the
   * run's final status based on pending flags.
   */
  private finalizeCycle(): void {
    this.stopHeartbeat();
    if (this.abortRequested) {
      this.commit({ ...this.state, status: "aborted", currentStage: null });
    } else if (this.pauseRequested) {
      this.commit({ ...this.state, status: "paused", currentStage: null });
    } else if (this.state.status === "error") {
      // The error already set the message.
    } else {
      this.commit({ ...this.state, status: "completed", currentStage: null });
    }
  }

  private async runPhase(index: number): Promise<void> {
    const settings = this.state.settings;
    if (!settings) return;
    const phase = this.state.phases[index];
    if (!phase) return;

    // Run the 4 stages in order. Each stage may set `warning` or `error`
    // and the scheduler reacts at the end.
    for (const agent of SEQUENTIAL_AGENTS) {
      if (this.shouldStop()) return;
      if (agent === "review") {
        await this.runReviewLoop(index);
      } else {
        await this.runStage(index, agent);
      }
      // If the stage ended in fatal error, stop the cycle and leave the run
      // in `error`. The user can inspect and eventually resume (Section 9).
      const stage = this.state.phases[index].stages[agent];
      if (stage.status === "error") {
        this.commit({
          ...this.state,
          status: "error",
          message: `phase ${phase.slug} / ${agent}: ${stage.message ?? "unknown error"}`,
        });
        return;
      }
    }
    // When all stages finished, aggregate the global phase status. If any
    // ended in warning, the phase is warning.
    const stages = this.state.phases[index].stages;
    const anyWarning =
      stages.analysis.status === "warning" ||
      stages.implementation.status === "warning" ||
      stages.review.status === "warning" ||
      stages.knowledge.status === "warning";
    this.patchPhase(index, {
      status: anyWarning ? "warning" : "done",
    });
    await this.persistState();
  }

  /**
   * Reviewer loop with retry cap. Each retry redoes implementation +
   * review until the reviewer approves or we hit the cap. At the cap, we
   * mark the phase as `warning` (reviewerExhausted=true) and move on to
   * knowledge — design decision #4.
   */
  private async runReviewLoop(phaseIndex: number): Promise<void> {
    const settings = this.state.settings;
    if (!settings) return;
    let attempt = 0;
    while (attempt < settings.maxRetries) {
      if (this.shouldStop()) return;
      attempt += 1;
      this.patchStage(phaseIndex, "review", { retries: attempt });
      const verdict = await this.runStage(phaseIndex, "review");
      // For `review`, runStage returns { approved, notes } or null (error).
      // The `undefined` only applies to non-review stages — defensive anyway.
      if (!verdict) {
        // Fatal reviewer error (we did not get to parse the verdict).
        return;
      }
      if (verdict.approved) {
        this.patchStage(phaseIndex, "review", { status: "done" });
        return;
      }
      // Verdict = retry. If attempts remain, re-run implementation with the
      // reviewer notes as additional input.
      if (attempt < settings.maxRetries) {
        if (this.shouldStop()) return;
        await this.runStage(phaseIndex, "implementation", { reviewNotes: verdict.notes });
      }
    }
    // Cap reached without approval.
    this.patchPhase(phaseIndex, { reviewerExhausted: true });
    this.patchStage(phaseIndex, "review", {
      status: "warning",
      message: "reviewer did not approve after 3 attempts — debt recorded in knowledge",
    });
  }

  /**
   * Executes an individual pipeline stage. Encapsulates:
   *   - diff snapshot before
   *   - invoke run_loop_agent
   *   - persistence of outputs/<phase>/<agent>.md and .diff
   *   - update of tokens/cost/status
   *
   * `extras.reviewNotes` lets `runReviewLoop` pass the reviewer notes to the
   * implementer on the retry.
   *
   * Returns for `review` an object `{ approved, notes }` extracted from the
   * CLI verdict; for the others it returns undefined.
   */
  private async runStage(
    phaseIndex: number,
    agent: SequentialAgent,
    extras?: { reviewNotes?: string },
  ): Promise<{ approved: boolean; notes: string } | null | undefined> {
    const settings = this.state.settings;
    if (!settings) return null;
    const phase = this.state.phases[phaseIndex];
    if (!phase) return null;

    this.updateCurrentStage(agent);
    this.patchStage(phaseIndex, agent, { status: "running", message: undefined });

    // 1. Diff snapshot before the agent. If it fails, it is not fatal —
    //    we store an empty string and move on.
    const diffBefore = await this.invokers
      .gitDiffSnapshot({ projectPath: settings.projectPath })
      .catch(() => "");

    // 2. Build the agent's user input. The system prompt goes by path;
    //    specific inputs (logic.md, knowledge from the previous phase, etc.)
    //    travel in the body.
    const userInput = await this.buildAgentInput(phaseIndex, agent, extras);

    const slot = this.slotForAgent(agent);
    const systemPromptPath = buildRunPromptPath(
      settings.projectPath,
      settings.runId,
      `${agent}.md` as LoopPromptName,
    );

    // 3. Invoke. Time tracker + error normalization. The heartbeat timer
    //    pulses `lastHeartbeat` every 5s while the CLI is running (Section
    //    9.3) — without this the interrupted-runs detector could confuse a
    //    slow agent with a crash.
    let result: AgentResult;
    this.startHeartbeat();
    try {
      result = await this.invokers.runAgent({
        cli: slot.cli,
        model: slot.model,
        cwd: settings.projectPath,
        systemPromptPath,
        userInput,
        timeoutSecs: settings.agentTimeoutSecs,
      });
    } catch (err) {
      this.stopHeartbeat();
      this.patchStage(phaseIndex, agent, {
        status: "error",
        message: `error invoking agent: ${stringifyError(err)}`,
      });
      await this.persistState();
      return null;
    }
    this.stopHeartbeat();

    if (result.error) {
      this.patchStage(phaseIndex, agent, {
        status: "error",
        message: result.error,
      });
      await this.persistState();
      return null;
    }

    // 4. Accumulate tokens/cost in the stage and in the run totals.
    const tokensIn = result.tokensIn ?? 0;
    const tokensOut = result.tokensOut ?? 0;
    const costUsd = result.costUsd ?? 0;
    this.patchStage(phaseIndex, agent, {
      tokensIn: phase.stages[agent].tokensIn + tokensIn,
      tokensOut: phase.stages[agent].tokensOut + tokensOut,
      costUsd: phase.stages[agent].costUsd + costUsd,
    });
    const role: LoopAgentRole = agent;
    this.commit({
      ...this.state,
      totals: {
        tokensIn: this.state.totals.tokensIn + tokensIn,
        tokensOut: this.state.totals.tokensOut + tokensOut,
        costUsd: this.state.totals.costUsd + costUsd,
      },
      byAgent: {
        ...this.state.byAgent,
        [role]: {
          tokensIn: this.state.byAgent[role].tokensIn + tokensIn,
          tokensOut: this.state.byAgent[role].tokensOut + tokensOut,
          costUsd: this.state.byAgent[role].costUsd + costUsd,
        },
      },
    });

    // 5. Persist md output.
    try {
      await this.invokers.writeOutput({
        projectPath: settings.projectPath,
        runId: settings.runId,
        phaseSlug: phase.slug,
        agent,
        ext: "md",
        content: result.text,
      });
    } catch (err) {
      this.patchStage(phaseIndex, agent, {
        status: "error",
        message: `could not persist output: ${stringifyError(err)}`,
      });
      await this.persistState();
      return null;
    }

    // 6. Snapshot the diff afterwards and persist diff = after (it's a
    //    differential snapshot against HEAD; the "before" only helps for
    //    auditing if the agent wrote on top of pre-existing changes — the
    //    real diff is the after one, which captures everything from HEAD).
    const diffAfter = await this.invokers
      .gitDiffSnapshot({ projectPath: settings.projectPath })
      .catch(() => "");
    const diffCombined = buildAgentDiff(diffBefore, diffAfter);
    try {
      await this.invokers.writeOutput({
        projectPath: settings.projectPath,
        runId: settings.runId,
        phaseSlug: phase.slug,
        agent,
        ext: "diff",
        content: diffCombined,
      });
    } catch (err) {
      // Not fatal — the md output is already there. Log and move on.
      console.error("loop scheduler: could not persist diff", err);
    }

    // 7. If the stage is not reviewer, mark done and persist state.
    if (agent !== "review") {
      this.patchStage(phaseIndex, agent, { status: "done" });
      await this.persistState();
      return undefined;
    }

    // Reviewer: parse the verdict and return it to the loop.
    const parsed = parseReviewVerdict(result.text);
    if (parsed.approved) {
      // Done is set by the caller (runReviewLoop) to reflect the cap correctly.
    }
    await this.persistState();
    return parsed;
  }

  /**
   * Builds the user input passed to the agent. Each agent receives different
   * files as context. Reads are tolerant to "does not exist yet" (empty
   * read) — design decision #1 makes the contract file-based on disk, not
   * temporal-order based.
   */
  private async buildAgentInput(
    phaseIndex: number,
    agent: SequentialAgent,
    extras?: { reviewNotes?: string },
  ): Promise<string> {
    const settings = this.state.settings;
    if (!settings) return "";
    const phase = this.state.phases[phaseIndex];
    // In sequential mode, "previous phase" is phaseIndex - 1 (flattened
    // topological order). In hybrid mode the same-batch phases run in
    // parallel: we cannot read knowledge between phases of the same batch
    // because it probably does not exist yet; instead we inject the
    // consolidated knowledge of the previous batch (Section 8.6) below.
    const prevPhase =
      this.state.mode === "sequential" && phaseIndex > 0 ? this.state.phases[phaseIndex - 1] : null;

    // Common inputs: phase logic.md + previous-phase knowledge.md
    // (sequential) or previous-batch knowledge (hybrid).
    const batchIndex = this.batchIndexForPhase(phase.slug);
    const prevBatchKnowledgePromise =
      this.state.mode === "hybrid" && batchIndex > 0
        ? this.invokers
            .readBatchFile({
              projectPath: settings.projectPath,
              runId: settings.runId,
              batchId: batchIdFor(batchIndex - 1),
              file: "knowledge.md",
            })
            .catch(() => "")
        : Promise.resolve("");

    const [logic, prevKnowledge, prevBatchKnowledge] = await Promise.all([
      this.invokers
        .readPhaseFile({
          projectPath: settings.projectPath,
          runId: settings.runId,
          phaseSlug: phase.slug,
          file: "logic.md",
        })
        .catch(() => ""),
      prevPhase
        ? this.invokers
            .readOutput({
              projectPath: settings.projectPath,
              runId: settings.runId,
              phaseSlug: prevPhase.slug,
              agent: "knowledge",
              ext: "md",
            })
            .catch(() => "")
        : Promise.resolve(""),
      prevBatchKnowledgePromise,
    ]);

    const parts: string[] = [];
    parts.push(`# Phase ${phase.id} · ${phase.name}\n`);
    parts.push("## logic.md\n");
    parts.push(logic.trim() || "(empty)");
    parts.push("\n");

    if (prevKnowledge.trim()) {
      parts.push(`## Knowledge from the previous phase (${prevPhase?.name ?? ""})\n`);
      parts.push(prevKnowledge.trim());
      parts.push("\n");
    }

    if (prevBatchKnowledge.trim()) {
      parts.push(`## Consolidated knowledge from the previous batch (batch-${batchIndex - 1})\n`);
      parts.push(prevBatchKnowledge.trim());
      parts.push("\n");
    }

    if (agent === "implementation" || agent === "review" || agent === "knowledge") {
      const analysis = await this.invokers
        .readOutput({
          projectPath: settings.projectPath,
          runId: settings.runId,
          phaseSlug: phase.slug,
          agent: "analysis",
          ext: "md",
        })
        .catch(() => "");
      if (analysis.trim()) {
        parts.push("## analysis.md\n");
        parts.push(analysis.trim());
        parts.push("\n");
      }
    }

    if (agent === "review" || agent === "knowledge") {
      const impl = await this.invokers
        .readOutput({
          projectPath: settings.projectPath,
          runId: settings.runId,
          phaseSlug: phase.slug,
          agent: "implementation",
          ext: "md",
        })
        .catch(() => "");
      const implDiff = await this.invokers
        .readOutput({
          projectPath: settings.projectPath,
          runId: settings.runId,
          phaseSlug: phase.slug,
          agent: "implementation",
          ext: "diff",
        })
        .catch(() => "");
      if (impl.trim()) {
        parts.push("## implementation.md\n");
        parts.push(impl.trim());
        parts.push("\n");
      }
      if (implDiff.trim()) {
        parts.push("## implementation.diff\n");
        parts.push("```diff\n");
        parts.push(implDiff.trim());
        parts.push("\n```\n");
      }
    }

    if (agent === "knowledge") {
      const review = await this.invokers
        .readOutput({
          projectPath: settings.projectPath,
          runId: settings.runId,
          phaseSlug: phase.slug,
          agent: "review",
          ext: "md",
        })
        .catch(() => "");
      if (review.trim()) {
        parts.push("## review.md\n");
        parts.push(review.trim());
        parts.push("\n");
      }
      if (phase.reviewerExhausted) {
        parts.push("## TECHNICAL DEBT\n");
        parts.push(
          "The reviewer did not approve after 3 attempts. This phase carries a propagated `warning`.\n" +
            "Explicitly record in your `knowledge.md` output what remained unresolved and what the user or a later phase would need to cover manually.\n",
        );
      }
    }

    if (extras?.reviewNotes && agent === "implementation") {
      parts.push("## Reviewer notes from the previous attempt\n");
      parts.push(extras.reviewNotes.trim());
      parts.push("\n\nAddress these notes before returning the output.\n");
    }

    return parts.join("\n");
  }

  // -------------------------------------------------------------------------
  // Section 8: integrator and conflicts
  // -------------------------------------------------------------------------

  /**
   * Runs the integrator for the given batch. Steps:
   *
   *   1. Read all the `knowledge.md` + `implementation.diff` of the batch
   *      phases. They are concatenated into the integrator's user input
   *      (prompt seed: `integration.md`).
   *   2. Detect structural conflicts: paths touched by more than one phase
   *      of the batch (we parse the diffs by their `diff --git` headers).
   *   3. Invoke `run_loop_agent` with the slot of the `integration` role.
   *   4. Persist the output to `<run>/outputs/batches/batch-N/knowledge.md`.
   *   5. Parse the integrator's final verdict (`INTEGRATION: ok|blocker`).
   *      If it is `blocker` or if there are structural conflicts, the
   *      outcome is `conflict`. Otherwise, `done`.
   *
   * Returns `"done" | "conflict" | "error"` so `runHybridCycle` decides
   * whether to continue, pause, or abort.
   */
  private async runIntegrator(
    batchIndex: number,
    phaseIndices: number[],
  ): Promise<"done" | "conflict" | "error"> {
    const settings = this.state.settings;
    if (!settings) return "error";

    this.patchIntegrator(batchIndex, { status: "running", message: undefined });
    this.commit({ ...this.state, currentStage: null });

    // 1. Read outputs/diffs of the batch.
    const phasesOfBatch = phaseIndices
      .map((i) => this.state.phases[i])
      .filter((p): p is PhaseState => Boolean(p));
    const reads = await Promise.all(
      phasesOfBatch.map(async (phase) => {
        const [knowledge, implDiff, implMd] = await Promise.all([
          this.invokers
            .readOutput({
              projectPath: settings.projectPath,
              runId: settings.runId,
              phaseSlug: phase.slug,
              agent: "knowledge",
              ext: "md",
            })
            .catch(() => ""),
          this.invokers
            .readOutput({
              projectPath: settings.projectPath,
              runId: settings.runId,
              phaseSlug: phase.slug,
              agent: "implementation",
              ext: "diff",
            })
            .catch(() => ""),
          this.invokers
            .readOutput({
              projectPath: settings.projectPath,
              runId: settings.runId,
              phaseSlug: phase.slug,
              agent: "implementation",
              ext: "md",
            })
            .catch(() => ""),
        ]);
        return { phase, knowledge, implDiff, implMd };
      }),
    );

    // 2. Structural conflict detection (Section 8.4): paths touched by
    //    multiple phases of the batch.
    const conflictsByPath = detectBatchConflicts(
      reads.map(({ phase, implDiff }) => ({
        phaseSlug: phase.slug,
        phaseName: phase.name,
        diff: implDiff,
      })),
    );

    // 3. Build user input for the integrator.
    const parts: string[] = [];
    parts.push(`# Integrator of batch ${batchIdFor(batchIndex)}\n`);
    parts.push(
      `There are ${phasesOfBatch.length} phase(s) in this batch. Your job: consolidate the knowledge and detect conflicts.\n`,
    );
    for (const { phase, knowledge, implDiff, implMd } of reads) {
      parts.push(`\n## Phase ${phase.id} · ${phase.name}\n`);
      if (knowledge.trim()) {
        parts.push("### knowledge.md\n");
        parts.push(knowledge.trim());
        parts.push("\n");
      } else {
        parts.push("### knowledge.md\n(no content — the phase produced no knowledge or failed)\n");
      }
      if (implMd.trim()) {
        parts.push("### implementation.md (summary)\n");
        parts.push(truncateForIntegrator(implMd));
        parts.push("\n");
      }
      if (implDiff.trim()) {
        parts.push("### implementation.diff\n");
        parts.push("```diff\n");
        parts.push(truncateForIntegrator(implDiff));
        parts.push("\n```\n");
      }
    }
    if (conflictsByPath.length > 0) {
      parts.push("\n## Structural conflicts detected by the scheduler\n");
      parts.push(
        "The following paths were modified by more than one phase of the batch — review them and mark `BLOCKER` if they break coherence:\n",
      );
      for (const c of conflictsByPath) {
        parts.push(`- \`${c.path}\` — phases: ${c.phases.join(", ")}\n`);
      }
    }

    const userInput = parts.join("\n");
    const slot = this.slotForAgent("integration");
    const systemPromptPath = buildRunPromptPath(
      settings.projectPath,
      settings.runId,
      "integration.md",
    );

    // 4. Invoke the integrator. Heartbeat pulses during the run (Section 9.3).
    let result: AgentResult;
    this.startHeartbeat();
    try {
      result = await this.invokers.runAgent({
        cli: slot.cli,
        model: slot.model,
        cwd: settings.projectPath,
        systemPromptPath,
        userInput,
        timeoutSecs: settings.agentTimeoutSecs,
      });
    } catch (err) {
      this.stopHeartbeat();
      this.patchIntegrator(batchIndex, {
        status: "error",
        message: `error invoking integrator: ${stringifyError(err)}`,
      });
      await this.persistState();
      return "error";
    }
    this.stopHeartbeat();
    if (result.error) {
      this.patchIntegrator(batchIndex, {
        status: "error",
        message: result.error,
      });
      await this.persistState();
      return "error";
    }

    // 5. Accumulate integrator tokens/cost.
    const tokensIn = result.tokensIn ?? 0;
    const tokensOut = result.tokensOut ?? 0;
    const costUsd = result.costUsd ?? 0;
    this.patchIntegrator(batchIndex, {
      tokensIn: this.state.integrators[batchIndex].tokensIn + tokensIn,
      tokensOut: this.state.integrators[batchIndex].tokensOut + tokensOut,
      costUsd: this.state.integrators[batchIndex].costUsd + costUsd,
    });
    this.commit({
      ...this.state,
      totals: {
        tokensIn: this.state.totals.tokensIn + tokensIn,
        tokensOut: this.state.totals.tokensOut + tokensOut,
        costUsd: this.state.totals.costUsd + costUsd,
      },
      byAgent: {
        ...this.state.byAgent,
        integration: {
          tokensIn: this.state.byAgent.integration.tokensIn + tokensIn,
          tokensOut: this.state.byAgent.integration.tokensOut + tokensOut,
          costUsd: this.state.byAgent.integration.costUsd + costUsd,
        },
      },
    });

    // 6. Persist output.
    try {
      await this.invokers.writeBatchFile({
        projectPath: settings.projectPath,
        runId: settings.runId,
        batchId: batchIdFor(batchIndex),
        file: "knowledge.md",
        content: result.text,
      });
    } catch (err) {
      this.patchIntegrator(batchIndex, {
        status: "error",
        message: `could not persist consolidated knowledge: ${stringifyError(err)}`,
      });
      await this.persistState();
      return "error";
    }

    // 7. Parse the verdict. If the agent marks blocker, conflict. If the
    //    structural detector found conflicting paths and the agent did not
    //    explicitly waive them with `INTEGRATION: ok`, treat as conflict
    //    (conservative side — design risk "integrator of the batch does ...
    //    before approving").
    const verdict = parseIntegrationVerdict(result.text);
    const conflictPaths = conflictsByPath.map((c) => c.path);
    const isBlocker =
      verdict.status === "blocker" || (conflictPaths.length > 0 && verdict.status !== "ok");

    if (isBlocker) {
      this.patchIntegrator(batchIndex, {
        status: "conflict",
        conflicts: conflictPaths,
        message:
          verdict.status === "blocker"
            ? "integrator marked BLOCKER — review the consolidated knowledge"
            : "the scheduler detected paths touched by multiple phases — review the knowledge",
      });
      await this.persistState();
      return "conflict";
    }

    this.patchIntegrator(batchIndex, {
      status: "done",
      conflicts: conflictPaths, // info for the user even if it doesn't break
      message: undefined,
    });
    await this.persistState();
    return "done";
  }

  /**
   * Pauses the cycle until the user decides via `resolveConflict`. In the
   * meantime the global status is "paused" and listeners can refresh the
   * view with the integrator card in "conflict" state.
   */
  private awaitConflictDecision(batchIndex: number): Promise<ConflictDecision> {
    this.commit({
      ...this.state,
      status: "paused",
      message: `conflict in batch-${batchIndex} — decide whether to continue, abort, or re-run`,
    });
    return new Promise<ConflictDecision>((resolve) => {
      this.conflictResolver = resolve;
    });
  }

  /**
   * Resets the state of the batch phases to `pending` and clears their
   * stages. Used when re-running after a conflict decision.
   */
  private resetBatchPhases(phaseIndices: number[]): void {
    const phases = this.state.phases.slice();
    for (const idx of phaseIndices) {
      const p = phases[idx];
      if (!p) continue;
      phases[idx] = {
        ...p,
        status: "pending",
        reviewerExhausted: false,
        stages: {
          analysis: createEmptyStage(),
          implementation: createEmptyStage(),
          review: createEmptyStage(),
          knowledge: createEmptyStage(),
        },
      };
    }
    this.commit({ ...this.state, phases });
  }

  private patchIntegrator(batchIndex: number, patch: Partial<IntegratorState>): void {
    const integrators = this.state.integrators.slice();
    const current = integrators[batchIndex];
    if (!current) return;
    integrators[batchIndex] = { ...current, ...patch };
    this.commit({ ...this.state, integrators });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private shouldStop(): boolean {
    return this.pauseRequested || this.abortRequested;
  }

  private slotForAgent(agent: LoopAgentRole): AgentSlot {
    const matrix = this.state.settings?.matrix;
    if (!matrix) return { cli: "claude", model: "claude-opus-4-7" };
    return matrix[agent];
  }

  /**
   * Returns the batch index a phase belongs to. -1 if the phase is not in
   * any batch (sequential mode or slug not listed).
   */
  private batchIndexForPhase(slug: string): number {
    if (this.state.mode !== "hybrid") return -1;
    for (let i = 0; i < this.state.batches.length; i++) {
      if (this.state.batches[i].includes(slug)) return i;
    }
    return -1;
  }

  private updateCurrentStage(stage: SequentialAgent): void {
    this.commit({ ...this.state, currentStage: stage });
  }

  private updatePhaseIndex(index: number): void {
    this.commit({ ...this.state, currentPhaseIndex: index });
  }

  private patchStage(
    phaseIndex: number,
    agent: SequentialAgent,
    patch: Partial<AgentStageState>,
  ): void {
    const phases = this.state.phases.slice();
    const phase = phases[phaseIndex];
    if (!phase) return;
    const next: PhaseState = {
      ...phase,
      stages: {
        ...phase.stages,
        [agent]: { ...phase.stages[agent], ...patch },
      },
    };
    phases[phaseIndex] = next;
    this.commit({ ...this.state, phases });
  }

  private patchPhase(phaseIndex: number, patch: Partial<PhaseState>): void {
    const phases = this.state.phases.slice();
    const phase = phases[phaseIndex];
    if (!phase) return;
    phases[phaseIndex] = { ...phase, ...patch };
    this.commit({ ...this.state, phases });
  }

  private commit(next: RunSchedulerState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  /**
   * Serializes the state.json and persists it. We update `lastHeartbeat`
   * every time (after each significant state change — Section 9.2). The
   * granular heartbeat lives in `pulseHeartbeat()` during agent invocations
   * (Section 9.3).
   */
  private async persistState(): Promise<void> {
    if (!this.state.settings) return;
    const heartbeat = Date.now();
    this.commit({ ...this.state, lastHeartbeat: heartbeat });
    const payload: PersistedRunState = buildPersistedRunState(this.state);
    try {
      await this.invokers.writeState({
        projectPath: this.state.settings.projectPath,
        runId: this.state.settings.runId,
        content: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("loop scheduler: could not persist state.json", err);
    }
  }

  /**
   * Section 9.3 — heartbeat pulse without re-serializing the whole run. It
   * fires while a stage is running: the interrupted-runs detector uses
   * `lastHeartbeat` to distinguish a live process from a dead one. If the
   * agent takes 4 minutes to respond but the timer pulses every 5s, the
   * run appears "alive" in the banner; if the app dies mid-invocation, the
   * last heartbeat is stale and the banner appears on reopen.
   *
   * We call `persistState()` so the change goes to disk. It's one write
   * per interval (default 5s) — cheap compared to the cost of an LLM
   * invocation.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.persistState();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Section 9.6 — hydrates the scheduler from a previously validated
   * `PersistedRunState` (see `state-schema.ts::validateRunState`). It does
   * NOT start the cycle; the caller decides whether to resume it with
   * `start()` or leave it in `paused` for the user to review first.
   *
   * Restriction: the caller must have discarded partial outputs before
   * calling (Section 9.6 discards `.md`s without `.diff` companion). The
   * scheduler does not inspect the FS — it only restores the state machine.
   */
  hydrateFromPersisted(persisted: PersistedRunState): void {
    this.stopHeartbeat();
    this.pauseRequested = false;
    this.abortRequested = false;
    this.conflictResolver = null;
    this.commit({
      status: persisted.status,
      mode: persisted.mode,
      phases: persisted.phases,
      batches: persisted.batches,
      integrators: persisted.integrators,
      currentPhaseIndex: persisted.currentPhaseIndex,
      currentBatchIndex: persisted.currentBatchIndex,
      currentStage: persisted.currentStage,
      totals: persisted.totals,
      byAgent: persisted.byAgent,
      message: persisted.message,
      lastHeartbeat: persisted.lastHeartbeat,
      settings: persisted.settings,
    });
  }
}

// ---------------------------------------------------------------------------
// Parsing and path helpers
// ---------------------------------------------------------------------------

/** Same separator heuristic as step1-chat / step2-phases. */
function buildRunPromptPath(projectPath: string, runId: string, name: LoopPromptName): string {
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return [projectPath, ".loop", "runs", runId, "prompts", name].join(sep);
}

/**
 * Parser for the reviewer verdict. The system prompt (`review.md`) asks the
 * agent to return `VERDICT: approved | retry` on the first line. We tolerate
 * uppercase and dashes — and if we don't find the header, we assume `retry`
 * with the full text as notes (better a false retry than a false approved).
 */
export function parseReviewVerdict(text: string): { approved: boolean; notes: string } {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(?:VERDICT|VEREDICTO)\s*[:=]\s*([\w-]+)/i);
    if (m) {
      const v = m[1].toLowerCase();
      const approved = v === "approved" || v === "aprobado" || v === "ok";
      // Notes: everything that comes after the header.
      const idx = text.indexOf(line);
      const notes = text.slice(idx + line.length).trim();
      return { approved, notes: approved ? "" : notes };
    }
  }
  return { approved: false, notes: text.trim() };
}

/**
 * Combines the "before" and "after" snapshots into a single legible blob. To
 * keep the .diff file useful without making it unmanageable, we store the
 * "after" diff (which already includes the agent's changes relative to HEAD)
 * and a header with the date. The "before" is preserved as a leading comment
 * for auditing — if the user sees an agent overwriting prior work, it will
 * show up there.
 */
export function buildAgentDiff(diffBefore: string, diffAfter: string): string {
  const stamp = new Date().toISOString();
  const parts: string[] = [];
  parts.push(`# Snapshot diff generated by the loop scheduler · ${stamp}`);
  parts.push("# (reflects the delta relative to HEAD after the agent run)");
  if (diffBefore.trim() && diffBefore.trim() !== diffAfter.trim()) {
    parts.push("#");
    parts.push("# --- prior state (summary) ---");
    for (const line of diffBefore.split(/\r?\n/).slice(0, 40)) {
      parts.push(`# ${line}`);
    }
    parts.push("# --- post-agent state ---");
  }
  parts.push("");
  parts.push(diffAfter.trim() || "(no changes relative to HEAD)");
  parts.push("");
  return parts.join("\n");
}

/**
 * Section 8.4 · structural conflict detection between phases of the same
 * batch. Parses the `diff --git a/<path> b/<path>` headers (canonical git
 * diff format). If two or more phases touch the same path, we report it.
 *
 * Not bulletproof — an agent could have written a file via shell without
 * git registering it (new untracked), but our snapshot includes untracked
 * as `# - <path>` lines on the side (see `git_diff_sync` in Rust). We
 * consume those too.
 *
 * Returns an ordered list of `{ path, phases[] }` with conflicting paths.
 */
export interface BatchConflict {
  path: string;
  phases: string[];
}

export function detectBatchConflicts(
  diffs: Array<{ phaseSlug: string; phaseName: string; diff: string }>,
): BatchConflict[] {
  const pathToPhases = new Map<string, Set<string>>();
  const headerRe = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  const untrackedRe = /^# - (.+)$/gm;

  for (const { phaseSlug, diff } of diffs) {
    if (!diff) continue;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    headerRe.lastIndex = 0;
    while ((m = headerRe.exec(diff)) !== null) {
      // a/b refer to the same path on in-place changes; renames use a!=b.
      // We report both sides so a rename gets flagged against any phase that
      // touches either the original or the new path.
      const a = m[1].trim();
      const b = m[2].trim();
      if (a) seen.add(a);
      if (b && b !== a) seen.add(b);
    }
    untrackedRe.lastIndex = 0;
    while ((m = untrackedRe.exec(diff)) !== null) {
      const p = m[1].trim();
      if (p) seen.add(p);
    }
    for (const path of seen) {
      let set = pathToPhases.get(path);
      if (!set) {
        set = new Set<string>();
        pathToPhases.set(path, set);
      }
      set.add(phaseSlug);
    }
  }

  const conflicts: BatchConflict[] = [];
  for (const [path, phases] of pathToPhases) {
    if (phases.size >= 2) {
      conflicts.push({ path, phases: Array.from(phases).sort() });
    }
  }
  conflicts.sort((a, b) => a.path.localeCompare(b.path));
  return conflicts;
}

/**
 * Section 8.3 · parsing of the integrator verdict. The `integration.md`
 * prompt asks to close with `INTEGRATION: ok` or `INTEGRATION: blocker`. We
 * tolerate uppercase/whitespace. If the header is missing, we assume `ok`
 * to avoid false blocks (the structural detector will still stop us if
 * there's a real conflict).
 */
export function parseIntegrationVerdict(text: string): { status: "ok" | "blocker" } {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*INTEGRATION\s*[:=]\s*([\w-]+)/i);
    if (m) {
      const v = m[1].toLowerCase();
      if (v === "blocker" || v === "block") return { status: "blocker" };
      return { status: "ok" };
    }
  }
  return { status: "ok" };
}

/**
 * Truncates a long blob for the integrator input. Keeps the first and last
 * N lines + a placeholder in the middle. Prevents a large diff or
 * implementation md from consuming the entire context window.
 */
function truncateForIntegrator(text: string, maxLines = 200): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, Math.floor(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [
    ...head,
    `... (truncated · ${lines.length - maxLines} line(s) omitted) ...`,
    ...tail,
  ].join("\n");
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Re-exports for Section 7.7 (run view)
// ---------------------------------------------------------------------------

export { ALL_AGENT_ROLES, SEQUENTIAL_AGENTS };

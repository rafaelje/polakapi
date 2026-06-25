// Step 3 engine: scheduler that orchestrates the per-phase pipeline.
//
// Overall design (aligned with design.md decision #1 "contract via files on
// disk" and #4 "reviewer cap at 3"):
//
// - The run consists of N phases (from `02-phases.md`).
//   - In `sequential` mode we process them in the topological order
//     returned by `topologicalBatches` — flattened to a linear list
//     because each phase has its deps satisfied by the time its turn
//     comes.
//   - In `hybrid` mode we process them in batches: each batch runs its
//     phases in parallel (`Promise.all`), and between batches the
//     integrator agent (5th agent) runs, consolidating knowledge and
//     detecting FS conflicts. If the integrator marks a blocker or the
//     scheduler detects paths touched by multiple phases, the run pauses
//     waiting for a user decision (continue / re-run / abort).
//
// - Per-phase pipeline: analysis → implementation → review (≤ 3 tries)
//   → knowledge. Each step's mechanics live in `phase-runner.ts`.
//
// - The class below is a thin orchestrator: it owns lifecycle (start /
//   pause / abort / resolveConflict / hydrate), the main cycle dispatch
//   (sequential vs hybrid), and the shared components (`StateStore`,
//   `HeartbeatController`, `PersistenceQueue`, `PhaseRunner`,
//   `IntegratorRunner`). All bulky mechanics (state mutation, agent
//   invocation, integrator) live in the sibling modules.

import { stringifyError } from "../../../shared/errors";

import { topologicalBatches, type Phase } from "../step2-phases";
import { buildPersistedRunState, type PersistedRunState } from "./state-schema";
import { ALL_AGENT_ROLES } from "./types";
import type { AgentSlot, LoopAgentRole } from "./types";

import {
  SEQUENTIAL_AGENTS,
  batchIdFor,
  createInitialState,
  createIntegratorState,
  createPhaseState,
  phaseToSlug,
  sequentialPhaseOrder,
} from "./run-scheduler/factories";
import {
  buildAgentDiff,
  detectBatchConflicts,
  parseIntegrationVerdict,
  parseReviewVerdict,
} from "./run-scheduler/helpers";
import { HeartbeatController } from "./run-scheduler/heartbeat";
import { IntegratorRunner } from "./run-scheduler/integrator-runner";
import { PersistenceQueue } from "./run-scheduler/persistence";
import { PhaseRunner } from "./run-scheduler/phase-runner";
import { StateStore } from "./run-scheduler/store";
import { defaultInvokers } from "./run-scheduler/invokers";
import type {
  AgentResult,
  AgentStageState,
  AgentStageStatus,
  BatchConflict,
  ConflictDecision,
  IntegratorState,
  IntegratorStatus,
  PhaseState,
  RunSchedulerListener,
  RunSchedulerState,
  RunSettings,
  RunStatus,
  SchedulerInvokers,
  SchedulerMode,
  SequentialAgent,
} from "./run-scheduler/types";

// Public re-exports kept stable for the rest of the app and the tests —
// consumers import from "./run-scheduler" without caring about the
// internal modules under `./run-scheduler/*`.
export {
  ALL_AGENT_ROLES,
  SEQUENTIAL_AGENTS,
  batchIdFor,
  buildAgentDiff,
  detectBatchConflicts,
  parseIntegrationVerdict,
  parseReviewVerdict,
  phaseToSlug,
  sequentialPhaseOrder,
};
export type {
  AgentResult,
  AgentStageState,
  AgentStageStatus,
  BatchConflict,
  ConflictDecision,
  IntegratorState,
  IntegratorStatus,
  PhaseState,
  RunSchedulerListener,
  RunSchedulerState,
  RunSettings,
  RunStatus,
  SchedulerInvokers,
  SchedulerMode,
  SequentialAgent,
};

const HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_CLI_SLOT: AgentSlot = { cli: "claude", model: "claude-opus-4-7" };

export class RunScheduler {
  private readonly store = new StateStore();
  private readonly invokers: SchedulerInvokers;
  private readonly heartbeat = new HeartbeatController(HEARTBEAT_INTERVAL_MS, () => {
    void this.persistState();
  });
  private readonly persistence = new PersistenceQueue();
  private readonly phaseRunner: PhaseRunner;
  private readonly integratorRunner: IntegratorRunner;

  /**
   * Internal flags that the main cycle checks between stages. They don't
   * kill subprocesses already in progress — the current agent finishes
   * before we yield.
   */
  private pauseRequested = false;
  private abortRequested = false;
  /** Promise of the main cycle — for external await. */
  private cycle: Promise<void> | null = null;
  /**
   * The user resolves a conflict reported by the integrator via
   * `resolveConflict()`. While there is no active conflict this stays
   * null; `awaitConflictDecision` sets it.
   */
  private conflictResolver: ((decision: ConflictDecision) => void) | null = null;

  constructor(invokers: SchedulerInvokers = defaultInvokers) {
    this.invokers = invokers;
    const sharedDeps = {
      store: this.store,
      invokers: this.invokers,
      heartbeat: this.heartbeat,
      shouldStop: () => this.shouldStop(),
      slotFor: (agent: LoopAgentRole) => this.slotForAgent(agent),
      persistState: () => this.persistState(),
    };
    this.phaseRunner = new PhaseRunner({
      ...sharedDeps,
      batchIndexForPhase: (slug) => this.batchIndexForPhase(slug),
    });
    this.integratorRunner = new IntegratorRunner(sharedDeps);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getState(): RunSchedulerState {
    return this.store.getState();
  }

  on(listener: RunSchedulerListener): () => void {
    return this.store.on(listener);
  }

  /**
   * Initializes the scheduler with an ordered set of phases + settings,
   * without starting execution. Useful for showing the initial view with
   * everything `pending`.
   *
   * In `"hybrid"` mode:
   * - We compute batches with `topologicalBatches` (Kahn).
   * - Each batch generates its entry in `state.integrators`.
   * - Phases are ordered by batch (preserving the internal Kahn order) so
   *   that `currentPhaseIndex` still makes sense in the flat view.
   */
  initialize(phases: Phase[], settings: RunSettings, mode: SchedulerMode = "sequential"): void {
    const batchesByPhase = topologicalBatches(phases);
    if (!batchesByPhase) {
      this.store.commit({
        ...createInitialState(),
        status: "error",
        message: "there is a cycle in the dependencies — cannot execute",
        settings,
      });
      return;
    }
    const ordered = batchesByPhase.flat();
    const phaseStates = ordered.map((p) => createPhaseState(p, phaseToSlug(p)));

    const batches: string[][] =
      mode === "hybrid" ? batchesByPhase.map((batch) => batch.map((p) => phaseToSlug(p))) : [];
    const integrators: IntegratorState[] =
      mode === "hybrid" ? batches.map((_, i) => createIntegratorState(i)) : [];

    this.pauseRequested = false;
    this.abortRequested = false;
    this.conflictResolver = null;
    this.store.commit({
      ...createInitialState(),
      mode,
      phases: phaseStates,
      batches,
      integrators,
      settings,
      currentBatchIndex: mode === "hybrid" ? 0 : -1,
      lastHeartbeat: Date.now(),
    });
  }

  /**
   * Starts the main scheduler cycle. Resolves when the run ends
   * (completed/aborted/error/paused).
   */
  async start(): Promise<void> {
    const state = this.store.getState();
    if (state.status === "running") return;
    if (!state.settings) {
      this.store.commit({
        ...state,
        status: "error",
        message: "scheduler without settings — call initialize() first",
      });
      return;
    }
    this.pauseRequested = false;
    this.abortRequested = false;
    this.store.commit({ ...state, status: "running", message: null });
    this.cycle = this.runCycle().catch((err: unknown) => {
      this.store.commit({
        ...this.store.getState(),
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
    if (this.store.getState().status !== "running") return;
    this.pauseRequested = true;
    this.store.commit({
      ...this.store.getState(),
      message: "pause requested — current agent will finish",
    });
  }

  /**
   * Aborts the run. Same behavior as pause regarding the current agent,
   * but upon stopping the status remains `aborted` and it cannot be
   * resumed without a new `start()`.
   */
  abort(): void {
    const status = this.store.getState().status;
    if (status !== "running" && status !== "paused") return;
    this.abortRequested = true;
    this.pauseRequested = true;
    this.store.commit({
      ...this.store.getState(),
      message: "abort requested — current agent will finish",
    });
    // If we are waiting on a conflict decision, unblock the await with
    // "abort" so the main cycle can exit.
    if (this.conflictResolver) {
      const resolver = this.conflictResolver;
      this.conflictResolver = null;
      resolver("abort");
    }
  }

  /**
   * The user resolves a conflict reported by the integrator. No-op if
   * there is no active conflict (status !== "paused" by integrator).
   */
  resolveConflict(decision: ConflictDecision): void {
    if (!this.conflictResolver) return;
    const resolver = this.conflictResolver;
    this.conflictResolver = null;
    resolver(decision);
  }

  /**
   * Hydrates the scheduler from a previously validated
   * `PersistedRunState` (see `state-schema.ts::validateRunState`). It
   * does NOT start the cycle; the caller decides whether to resume it
   * with `start()` or leave it for the user to review first.
   *
   * Restriction: the caller must have discarded partial outputs before
   * calling (Section 9.6 discards `.md`s without `.diff` companion).
   * The scheduler does not inspect the FS — it only restores the state
   * machine.
   */
  hydrateFromPersisted(persisted: PersistedRunState): void {
    this.heartbeat.reset();
    this.pauseRequested = false;
    this.abortRequested = false;
    this.conflictResolver = null;
    this.store.commit({
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

  // -------------------------------------------------------------------------
  // Main cycle
  // -------------------------------------------------------------------------

  private async runCycle(): Promise<void> {
    if (this.store.getState().mode === "hybrid") {
      await this.runHybridCycle();
    } else {
      await this.runSequentialCycle();
    }
  }

  private async runSequentialCycle(): Promise<void> {
    const startIndex = Math.max(0, this.store.getState().currentPhaseIndex);
    for (let i = startIndex; i < this.store.getState().phases.length; i++) {
      if (this.shouldStop()) break;
      this.store.updatePhaseIndex(i);
      await this.phaseRunner.runPhase(i);
    }
    this.finalizeCycle();
    await this.persistState();
  }

  /**
   * Hybrid-mode cycle. For each batch:
   *   1. Launch all phases of the batch in parallel.
   *   2. Wait for them to finish (ok, warning, or error).
   *   3. Detect FS conflicts via diff overlap.
   *   4. Run the integrator over the batch outputs.
   *   5. If conflict, pause until the user decides.
   *
   * The consolidated knowledge of batch N becomes available to the
   * phases of batch N+1 via `buildAgentInput` reading it from disk.
   */
  private async runHybridCycle(): Promise<void> {
    let batchIndex = Math.max(0, this.store.getState().currentBatchIndex);
    while (batchIndex < this.store.getState().batches.length) {
      if (this.shouldStop()) break;
      this.store.commit({ ...this.store.getState(), currentBatchIndex: batchIndex });

      const slugs = this.store.getState().batches[batchIndex];
      const phaseIndices = slugs
        .map((slug) => this.store.getState().phases.findIndex((p) => p.slug === slug))
        .filter((i) => i >= 0);
      if (phaseIndices.length === 0) {
        batchIndex += 1;
        continue;
      }

      await Promise.all(phaseIndices.map((idx) => this.phaseRunner.runPhase(idx)));

      if (this.shouldStop()) break;
      // If any batch phase ended in fatal `error`, don't run the
      // integrator and leave the run in error.
      const anyError = phaseIndices.some((i) => this.store.getState().phases[i].status === "error");
      if (anyError || this.store.getState().status === "error") {
        break;
      }

      const outcome = await this.integratorRunner.runIntegrator(batchIndex, phaseIndices);
      if (this.shouldStop()) break;
      if (outcome === "error") {
        this.store.commit({
          ...this.store.getState(),
          status: "error",
          message: `integrator batch-${batchIndex} failed — see outputs/batches/${batchIdFor(batchIndex)}/`,
        });
        break;
      }

      if (outcome === "conflict") {
        const decision = await this.awaitConflictDecision(batchIndex);
        if (decision === "abort") {
          this.abortRequested = true;
          break;
        }
        if (decision === "rerun") {
          this.integratorRunner.resetBatchPhases(phaseIndices);
          this.store.patchIntegrator(batchIndex, {
            status: "pending",
            conflicts: [],
            message: undefined,
          });
          this.store.commit({ ...this.store.getState(), status: "running", message: null });
          continue;
        }
        // decision === "continue": treat the integrator as done and advance.
        this.store.patchIntegrator(batchIndex, {
          status: "done",
          message: "conflicts accepted by the user — the flow continues",
        });
        this.store.commit({ ...this.store.getState(), status: "running", message: null });
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
    // Hard reset: every paired start/stop should have balanced out by
    // now, but `finalizeCycle()` is also reached on abort/error mid-stage
    // with pending refs.
    this.heartbeat.reset();
    if (this.abortRequested) {
      this.store.commit({ ...this.store.getState(), status: "aborted", currentStage: null });
    } else if (this.pauseRequested) {
      this.store.commit({ ...this.store.getState(), status: "paused", currentStage: null });
    } else if (this.store.getState().status === "error") {
      // The error already set the message.
    } else {
      this.store.commit({ ...this.store.getState(), status: "completed", currentStage: null });
    }
  }

  /**
   * Pauses the cycle until the user decides via `resolveConflict`. In
   * the meantime the global status is "paused" and listeners can refresh
   * the view with the integrator card in "conflict" state.
   */
  private awaitConflictDecision(batchIndex: number): Promise<ConflictDecision> {
    this.store.commit({
      ...this.store.getState(),
      status: "paused",
      message: `conflict in batch-${batchIndex} — decide whether to continue, abort, or re-run`,
    });
    return new Promise<ConflictDecision>((resolve) => {
      this.conflictResolver = resolve;
    });
  }

  // -------------------------------------------------------------------------
  // Persistence + cooperative-stop check
  // -------------------------------------------------------------------------

  /**
   * Persists `state.json` through the shared queue. We update
   * `lastHeartbeat` synchronously so any concurrent reader sees a fresh
   * in-memory value before the disk write enqueues.
   */
  private async persistState(): Promise<void> {
    const state = this.store.getState();
    if (!state.settings) return;
    this.store.commit({ ...state, lastHeartbeat: Date.now() });
    const payload: PersistedRunState = buildPersistedRunState(this.store.getState());
    const settings = state.settings;
    await this.persistence.enqueue(async () => {
      await this.invokers.writeState({
        projectPath: settings.projectPath,
        runId: settings.runId,
        content: JSON.stringify(payload),
      });
    });
  }

  private shouldStop(): boolean {
    // A fatal `error` ends the cycle the same way pause/abort do —
    // without it, `runSequentialCycle` would keep iterating to the next
    // phase even after `runPhase` flagged a fatal stage. `finalizeCycle`
    // preserves the `error` status as long as no abort/pause was
    // requested in between.
    return this.pauseRequested || this.abortRequested || this.store.getState().status === "error";
  }

  private slotForAgent(agent: LoopAgentRole): AgentSlot {
    const matrix = this.store.getState().settings?.matrix;
    if (!matrix) return DEFAULT_CLI_SLOT;
    return matrix[agent];
  }

  /**
   * Returns the batch index a phase belongs to. -1 if the phase is not
   * in any batch (sequential mode or slug not listed).
   */
  private batchIndexForPhase(slug: string): number {
    const state = this.store.getState();
    if (state.mode !== "hybrid") return -1;
    for (let i = 0; i < state.batches.length; i++) {
      if (state.batches[i].includes(slug)) return i;
    }
    return -1;
  }
}

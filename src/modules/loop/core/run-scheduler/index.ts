import { stringifyError } from "../../../../shared/errors";

import { topologicalBatches, type Phase } from "../../step2-phases";
import { buildPersistedRunState, type PersistedRunState } from "../state-schema";
import { ALL_AGENT_ROLES } from "../../types";
import type { AgentSlot, LoopAgentRole } from "../../types";

import {
  SEQUENTIAL_AGENTS,
  batchIdFor,
  createInitialState,
  createIntegratorState,
  createPhaseState,
  phaseToSlug,
  sequentialPhaseOrder,
} from "./factories";
import {
  buildAgentDiff,
  detectBatchConflicts,
  parseIntegrationVerdict,
  parseReviewVerdict,
} from "./helpers";
import { HeartbeatController } from "./heartbeat";
import { IntegratorRunner } from "./integrator-runner";
import { PersistenceQueue } from "./persistence";
import { PhaseRunner } from "./phase-runner";
import { StateStore } from "./store";
import { defaultInvokers } from "./invokers";
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
} from "./types";

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

  private pauseRequested = false;
  private abortRequested = false;
  private cycle: Promise<void> | null = null;
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

  getState(): RunSchedulerState {
    return this.store.getState();
  }

  on(listener: RunSchedulerListener): () => void {
    return this.store.on(listener);
  }

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

  async start(): Promise<void> {
    const state = this.store.getState();
    if (state.status === "running") return;
    // From a terminal state, a fresh attempt must call initialize() first —
    // otherwise the persisted indices would re-run the last batch.
    if (state.status === "completed" || state.status === "aborted" || state.status === "error") {
      return;
    }
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

  pause(): void {
    if (this.store.getState().status !== "running") return;
    this.pauseRequested = true;
    this.store.commit({
      ...this.store.getState(),
      message: "pause requested — current agent will finish",
    });
  }

  abort(): void {
    const status = this.store.getState().status;
    if (status !== "running" && status !== "paused") return;
    this.abortRequested = true;
    this.pauseRequested = true;
    this.store.commit({
      ...this.store.getState(),
      message: "abort requested — current agent will finish",
    });
    if (this.conflictResolver) {
      const resolver = this.conflictResolver;
      this.conflictResolver = null;
      resolver("abort");
    }
  }

  resolveConflict(decision: ConflictDecision): void {
    if (!this.conflictResolver) return;
    const resolver = this.conflictResolver;
    this.conflictResolver = null;
    resolver(decision);
  }

  /**
   * Restores the scheduler state machine. Does NOT start the cycle. The
   * caller must have discarded partial outputs (`.md` without `.diff`
   * companion) before hydrating — this method does not inspect the FS.
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

      // Sequential within a batch: phases share a working tree, so concurrent
      // `git diff HEAD` snapshots would cross-contaminate each phase's .diff
      // and poison detectBatchConflicts. Real parallelism needs worktrees.
      for (const idx of phaseIndices) {
        if (this.shouldStop()) break;
        await this.phaseRunner.runPhase(idx);
      }

      if (this.shouldStop()) break;
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
          this.integratorRunner.resetBatchPhases(phaseIndices, batchIndex);
          this.store.patchIntegrator(batchIndex, {
            status: "pending",
            conflicts: [],
            message: undefined,
          });
          this.store.commit({ ...this.store.getState(), status: "running", message: null });
          continue;
        }
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

  private finalizeCycle(): void {
    // Hard reset: `finalizeCycle()` can be reached on abort/error mid-stage
    // with pending heartbeat refs that the paired stops never balanced.
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

  /**
   * Updates `lastHeartbeat` synchronously so concurrent readers see a fresh
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
    // A fatal `error` ends the cycle the same way pause/abort do — without
    // it, `runSequentialCycle` would keep iterating past a fatal stage.
    return this.pauseRequested || this.abortRequested || this.store.getState().status === "error";
  }

  private slotForAgent(agent: LoopAgentRole): AgentSlot {
    const matrix = this.store.getState().settings?.matrix;
    if (!matrix) return DEFAULT_CLI_SLOT;
    return matrix[agent];
  }

  private batchIndexForPhase(slug: string): number {
    const state = this.store.getState();
    if (state.mode !== "hybrid") return -1;
    for (let i = 0; i < state.batches.length; i++) {
      if (state.batches[i].includes(slug)) return i;
    }
    return -1;
  }
}

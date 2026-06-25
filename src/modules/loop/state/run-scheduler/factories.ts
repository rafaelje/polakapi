// State factories + pure DAG-ordering helpers used by the scheduler. Kept
// separate from the class so they can be tested in isolation and so the
// class file stays focused on the state machine.

import { topologicalBatches, type Phase } from "../../step2-phases";

import type {
  AgentStageState,
  IntegratorState,
  PhaseState,
  RunSchedulerState,
  SequentialAgent,
} from "./types";

export const SEQUENTIAL_AGENTS: readonly SequentialAgent[] = [
  "analysis",
  "implementation",
  "review",
  "knowledge",
] as const;

export function createEmptyStage(): AgentStageState {
  return {
    status: "pending",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    retries: 0,
  };
}

export function createPhaseState(phase: Phase, slug: string): PhaseState {
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

export function createInitialState(): RunSchedulerState {
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

export function createIntegratorState(batchIndex: number): IntegratorState {
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
 * flatten is exact. If there are parallel branches, we process them in
 * batch order (the internal order doesn't matter because their deps are
 * in previous batches).
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

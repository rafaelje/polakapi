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

export function batchIdFor(index: number): string {
  return `batch-${index}`;
}

export function sequentialPhaseOrder(phases: Phase[]): Phase[] | null {
  const batches = topologicalBatches(phases);
  if (!batches) return null;
  return batches.flat();
}

export function phaseToSlug(phase: Phase): string {
  const safeName = phase.name.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${phase.id}-${safeName}`;
}

import { describe, expect, it } from "vitest";

import { rewindRunningStages } from "./resume-detector";
import { STATE_SCHEMA_VERSION, type PersistedRunState } from "./state-schema";

function makeState(): PersistedRunState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: "running",
    mode: "sequential",
    phases: [
      {
        slug: "01-init",
        id: "01",
        name: "Init",
        status: "running",
        stages: {
          analysis: { status: "done", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
          implementation: { status: "running", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
          review: { status: "pending", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
          knowledge: { status: "pending", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
        },
        reviewerExhausted: false,
      },
      {
        slug: "02-render",
        id: "02",
        name: "Render",
        status: "done",
        stages: {
          analysis: { status: "done", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
          implementation: { status: "done", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
          review: { status: "done", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
          knowledge: { status: "done", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
        },
        reviewerExhausted: false,
      },
    ],
    batches: [],
    integrators: [
      {
        batchId: "batch-0",
        batchIndex: 0,
        status: "running",
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        conflicts: [],
      },
    ],
    currentPhaseIndex: 0,
    currentBatchIndex: 0,
    currentStage: "implementation",
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

describe("rewindRunningStages", () => {
  it("degrada el stage running a pending", () => {
    const out = rewindRunningStages(makeState());
    expect(out.phases[0].stages.implementation.status).toBe("pending");
  });

  it("preserva stages done", () => {
    const out = rewindRunningStages(makeState());
    expect(out.phases[0].stages.analysis.status).toBe("done");
    expect(out.phases[1].stages.knowledge.status).toBe("done");
  });

  it("rebaja status de la fase con running a pending", () => {
    const out = rewindRunningStages(makeState());
    expect(out.phases[0].status).toBe("pending");
    // Fase 2 no tiene running stages, mantiene su status original.
    expect(out.phases[1].status).toBe("done");
  });

  it("integrador running vuelve a pending", () => {
    const out = rewindRunningStages(makeState());
    expect(out.integrators[0].status).toBe("pending");
  });

  it("currentStage queda null", () => {
    const out = rewindRunningStages(makeState());
    expect(out.currentStage).toBeNull();
  });

  it("status global queda paused y tiene mensaje", () => {
    const out = rewindRunningStages(makeState());
    expect(out.status).toBe("paused");
    expect(out.message).toBeTruthy();
  });

  it("inmutabilidad: el state original no se muta", () => {
    const original = makeState();
    rewindRunningStages(original);
    expect(original.phases[0].stages.implementation.status).toBe("running");
    expect(original.integrators[0].status).toBe("running");
  });
});

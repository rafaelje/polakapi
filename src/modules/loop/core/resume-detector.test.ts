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
  it("downgrades the running stage to pending", () => {
    const out = rewindRunningStages(makeState());
    expect(out.phases[0].stages.implementation.status).toBe("pending");
  });

  it("preserves done stages", () => {
    const out = rewindRunningStages(makeState());
    expect(out.phases[0].stages.analysis.status).toBe("done");
    expect(out.phases[1].stages.knowledge.status).toBe("done");
  });

  it("downgrades status of the phase with running to pending", () => {
    const out = rewindRunningStages(makeState());
    expect(out.phases[0].status).toBe("pending");
    // Phase 2 has no running stages, keeps its original status.
    expect(out.phases[1].status).toBe("done");
  });

  it("running integrator goes back to pending", () => {
    const out = rewindRunningStages(makeState());
    expect(out.integrators[0].status).toBe("pending");
  });

  it("currentStage is left null", () => {
    const out = rewindRunningStages(makeState());
    expect(out.currentStage).toBeNull();
  });

  it("global status ends paused and carries a message", () => {
    const out = rewindRunningStages(makeState());
    expect(out.status).toBe("paused");
    expect(out.message).toBeTruthy();
  });

  it("immutability: the original state is not mutated", () => {
    const original = makeState();
    rewindRunningStages(original);
    expect(original.phases[0].stages.implementation.status).toBe("running");
    expect(original.integrators[0].status).toBe("running");
  });

  it("preserves a phase's `warning` status when only an unrelated stage rewinds", () => {
    // The reviewer exhausted retries (review = warning, phase = warning) and
    // then the run crashed while running knowledge. The rewind must NOT
    // overwrite the phase status with `pending` and hide the warning.
    const s = makeState();
    s.phases[0].status = "warning";
    s.phases[0].reviewerExhausted = true;
    s.phases[0].stages.analysis.status = "done";
    s.phases[0].stages.implementation.status = "done";
    s.phases[0].stages.review.status = "warning";
    s.phases[0].stages.knowledge.status = "running";

    const out = rewindRunningStages(s);

    expect(out.phases[0].stages.knowledge.status).toBe("pending");
    expect(out.phases[0].stages.review.status).toBe("warning");
    expect(out.phases[0].status).toBe("warning");
  });

  it("preserves review.message and decrements retries when review was running", () => {
    // A review at attempt 2 was in flight when the run crashed. The
    // implementation retry that resumes must see the prior reviewer's notes
    // (review.message preserved) and the runReviewLoop must re-attempt N,
    // not skip past it — so retries is decremented by 1.
    const s = makeState();
    s.phases[0].stages.implementation.status = "running";
    s.phases[0].stages.review = {
      status: "running",
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      retries: 2,
      message: "needs more docs on the error path",
    };

    const out = rewindRunningStages(s);

    expect(out.phases[0].stages.review.status).toBe("pending");
    expect(out.phases[0].stages.review.message).toBe("needs more docs on the error path");
    expect(out.phases[0].stages.review.retries).toBe(1);
    // Implementation rewind still clears its own message (no notes there).
    expect(out.phases[0].stages.implementation.message).toBeUndefined();
  });
});

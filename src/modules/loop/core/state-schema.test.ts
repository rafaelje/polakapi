import { describe, expect, it } from "vitest";

import {
  buildPersistedRunState,
  parsePersistedRunState,
  STATE_SCHEMA_VERSION,
  validateRunState,
} from "./state-schema";

// Builds a valid, complete state to reuse across tests. The shape is the
// same as `RunSchedulerState` — matches 1:1 what the scheduler serializes.
function validSnapshot() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: "running" as const,
    mode: "sequential" as const,
    phases: [
      {
        slug: "01-init",
        id: "01",
        name: "Init",
        status: "running" as const,
        stages: {
          analysis: {
            status: "done" as const,
            tokensIn: 100,
            tokensOut: 200,
            costUsd: 0.01,
            retries: 0,
          },
          implementation: {
            status: "running" as const,
            tokensIn: 50,
            tokensOut: 100,
            costUsd: 0.005,
            retries: 0,
          },
          review: { status: "pending" as const, tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
          knowledge: {
            status: "pending" as const,
            tokensIn: 0,
            tokensOut: 0,
            costUsd: 0,
            retries: 0,
          },
        },
        reviewerExhausted: false,
      },
    ],
    batches: [],
    integrators: [],
    currentPhaseIndex: 0,
    currentBatchIndex: -1,
    currentStage: "implementation" as const,
    totals: { tokensIn: 150, tokensOut: 300, costUsd: 0.015 },
    byAgent: {
      analysis: { tokensIn: 100, tokensOut: 200, costUsd: 0.01 },
      implementation: { tokensIn: 50, tokensOut: 100, costUsd: 0.005 },
      review: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      knowledge: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      integration: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    },
    message: null,
    lastHeartbeat: 1_700_000_000_000,
    settings: {
      projectPath: "/tmp/p",
      runId: "abc-123",
      matrix: {
        analysis: { cli: "claude" as const, model: "claude-opus-4-7" },
        implementation: { cli: "claude" as const, model: "claude-opus-4-7" },
        review: { cli: "claude" as const, model: "claude-opus-4-7" },
        knowledge: { cli: "claude" as const, model: "claude-opus-4-7" },
        integration: { cli: "claude" as const, model: "claude-opus-4-7" },
      },
      promptOverrides: {},
      maxRetries: 3,
      agentTimeoutSecs: 300,
    },
  };
}

describe("validateRunState", () => {
  it("accepts a valid complete snapshot", () => {
    const v = validateRunState(validSnapshot());
    expect(v).not.toBeNull();
    expect(v?.status).toBe("running");
    expect(v?.phases).toHaveLength(1);
    expect(v?.phases[0].stages.analysis.status).toBe("done");
  });

  it("rejects incorrect schemaVersion", () => {
    const s = { ...validSnapshot(), schemaVersion: 999 };
    expect(validateRunState(s)).toBeNull();
  });

  it("rejects invalid status", () => {
    const s = { ...validSnapshot(), status: "ufo" };
    expect(validateRunState(s)).toBeNull();
  });

  it("rejects invalid mode", () => {
    const s = { ...validSnapshot(), mode: "magic" };
    expect(validateRunState(s)).toBeNull();
  });

  it("rejects a phase without the 4 stages", () => {
    const s = validSnapshot();
    // @ts-expect-error -- intentional, we want the validator to catch the broken shape
    delete s.phases[0].stages.review;
    expect(validateRunState(s)).toBeNull();
  });

  it("rejects batches with a non-string element", () => {
    const s = { ...validSnapshot(), batches: [[42]] };
    expect(validateRunState(s)).toBeNull();
  });

  it("normalizes message: undefined → null", () => {
    const s = validSnapshot();
    // @ts-expect-error -- the shape accepts string | null, undefined is tolerated
    delete s.message;
    const v = validateRunState(s);
    expect(v?.message).toBeNull();
  });

  it("invalid settings (no projectPath) → settings normalizes to null", () => {
    // Design: the validator preserves the rest of the state (phases, totals)
    // so the UI can show the progress, but marks settings=null. The resume
    // caller detects settings=null and disables resume.
    const s = validSnapshot();
    s.settings = { ...s.settings, projectPath: "" };
    const v = validateRunState(s);
    expect(v).not.toBeNull();
    expect(v?.settings).toBeNull();
  });

  it("null settings are valid (run not started)", () => {
    const s = validSnapshot();
    // @ts-expect-error -- intentional for the "scheduler without initialize" case
    s.settings = null;
    const v = validateRunState(s);
    expect(v).not.toBeNull();
    expect(v?.settings).toBeNull();
  });

  it("matrix with unknown CLI → settings normalizes to null", () => {
    const s = validSnapshot();
    // @ts-expect-error -- we force an invalid CLI
    s.settings.matrix.analysis = { cli: "magic-cli", model: "x" };
    const v = validateRunState(s);
    expect(v).not.toBeNull();
    expect(v?.settings).toBeNull();
  });

  it("invalid currentStage normalizes to null", () => {
    const s = { ...validSnapshot(), currentStage: "wat" };
    const v = validateRunState(s);
    expect(v?.currentStage).toBeNull();
  });
});

describe("parsePersistedRunState", () => {
  it("returns null for empty string", () => {
    expect(parsePersistedRunState("")).toBeNull();
    expect(parsePersistedRunState("   ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parsePersistedRunState("{ not json")).toBeNull();
  });

  it("round-trips with buildPersistedRunState", () => {
    const snapshot = validSnapshot();
    const payload = JSON.stringify(buildPersistedRunState(snapshot));
    const parsed = parsePersistedRunState(payload);
    expect(parsed).not.toBeNull();
    expect(parsed?.phases[0].slug).toBe("01-init");
    expect(parsed?.totals.tokensIn).toBe(150);
  });
});

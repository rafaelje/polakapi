import { describe, expect, it } from "vitest";

import {
  buildPersistedRunState,
  parsePersistedRunState,
  STATE_SCHEMA_VERSION,
  validateRunState,
} from "./state-schema";

// Construye un state válido completo para reusar en los tests. El shape es el
// mismo que `RunSchedulerState` — coincide 1:1 con lo que el scheduler serializa.
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
  it("acepta un snapshot completo válido", () => {
    const v = validateRunState(validSnapshot());
    expect(v).not.toBeNull();
    expect(v?.status).toBe("running");
    expect(v?.phases).toHaveLength(1);
    expect(v?.phases[0].stages.analysis.status).toBe("done");
  });

  it("rechaza schemaVersion incorrecto", () => {
    const s = { ...validSnapshot(), schemaVersion: 999 };
    expect(validateRunState(s)).toBeNull();
  });

  it("rechaza status inválido", () => {
    const s = { ...validSnapshot(), status: "ufo" };
    expect(validateRunState(s)).toBeNull();
  });

  it("rechaza modo inválido", () => {
    const s = { ...validSnapshot(), mode: "magic" };
    expect(validateRunState(s)).toBeNull();
  });

  it("rechaza fase sin los 4 stages", () => {
    const s = validSnapshot();
    // @ts-expect-error -- intencional, queremos que el validator atrape el shape roto
    delete s.phases[0].stages.review;
    expect(validateRunState(s)).toBeNull();
  });

  it("rechaza batches con elemento no-string", () => {
    const s = { ...validSnapshot(), batches: [[42]] };
    expect(validateRunState(s)).toBeNull();
  });

  it("normaliza message: undefined → null", () => {
    const s = validSnapshot();
    // @ts-expect-error -- el shape acepta string | null, undefined es tolerado
    delete s.message;
    const v = validateRunState(s);
    expect(v?.message).toBeNull();
  });

  it("settings inválido (sin projectPath) → settings se normaliza a null", () => {
    // Diseño: el validator preserva el resto del state (fases, totales) para
    // que la UI pueda mostrar el progreso, pero marca settings=null. El
    // caller del resume detecta settings=null y deshabilita retomar.
    const s = validSnapshot();
    s.settings = { ...s.settings, projectPath: "" };
    const v = validateRunState(s);
    expect(v).not.toBeNull();
    expect(v?.settings).toBeNull();
  });

  it("settings nulo es válido (run sin arrancar)", () => {
    const s = validSnapshot();
    // @ts-expect-error -- intencional para el caso "scheduler sin initialize"
    s.settings = null;
    const v = validateRunState(s);
    expect(v).not.toBeNull();
    expect(v?.settings).toBeNull();
  });

  it("matrix con CLI desconocido → settings se normaliza a null", () => {
    const s = validSnapshot();
    // @ts-expect-error -- forzamos un CLI inválido
    s.settings.matrix.analysis = { cli: "magic-cli", model: "x" };
    const v = validateRunState(s);
    expect(v).not.toBeNull();
    expect(v?.settings).toBeNull();
  });

  it("currentStage inválido se normaliza a null", () => {
    const s = { ...validSnapshot(), currentStage: "wat" };
    const v = validateRunState(s);
    expect(v?.currentStage).toBeNull();
  });
});

describe("parsePersistedRunState", () => {
  it("devuelve null para string vacío", () => {
    expect(parsePersistedRunState("")).toBeNull();
    expect(parsePersistedRunState("   ")).toBeNull();
  });

  it("devuelve null para JSON inválido", () => {
    expect(parsePersistedRunState("{ not json")).toBeNull();
  });

  it("round-trip con buildPersistedRunState", () => {
    const snapshot = validSnapshot();
    const payload = JSON.stringify(buildPersistedRunState(snapshot));
    const parsed = parsePersistedRunState(payload);
    expect(parsed).not.toBeNull();
    expect(parsed?.phases[0].slug).toBe("01-init");
    expect(parsed?.totals.tokensIn).toBe(150);
  });
});

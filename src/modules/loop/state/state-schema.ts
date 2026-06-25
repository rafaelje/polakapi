// Schema formal de `state.json` para persistencia y resume (Section 9).
//
// El scheduler (`run-scheduler.ts`) serializa su estado vía `persistState()`
// después de cada cambio significativo (cambio de etapa, fin de fase, fin de
// integrador, pausa, abort, resolveConflict, etc). Ese archivo es la única
// fuente de verdad para retomar un run interrumpido — al abrir `/loop` sobre
// un project escaneamos `<project>/.loop/runs/<id>/state.json` buscando los
// que quedaron con `status: "running"` y `lastHeartbeat` viejo.
//
// Diseño:
// - El shape coincide 1:1 con `RunSchedulerState` exportado por
//   `run-scheduler.ts` para evitar mapeos. El campo extra `schemaVersion` va
//   en el wrapper top-level. Si en el futuro cambia el shape interno, subimos
//   `schemaVersion` y agregamos un migrator (mismo patrón que el store de
//   workspaces).
// - `validateRunState(value)` es un guard runtime que devuelve un
//   `PersistedRunState` o `null`. NO tira excepciones — los call-sites tratan
//   `null` como "data inválida o esquema viejo, descartar".
// - El validador es tolerante con campos opcionales (ej. `message: string |
//   null | undefined` se normaliza a `null`), pero estricto con el shape
//   estructural (faltan los 5 stages → null).

import type {
  AgentStageState,
  AgentStageStatus,
  IntegratorState,
  IntegratorStatus,
  PhaseState,
  RunSchedulerState,
  RunSettings,
  RunStatus,
  SchedulerMode,
  SequentialAgent,
} from "./run-scheduler";
import type { AgentSlot, LoopAgentRole, LoopCli, LoopPromptName, ProfileMatrix } from "./types";

/** Version actual del schema persistido en `state.json`. */
export const STATE_SCHEMA_VERSION = 1 as const;

/**
 * Wrapper top-level que persiste el scheduler. Incluye `schemaVersion` para
 * habilitar migraciones futuras sin romper resumes existentes.
 */
export interface PersistedRunState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  /** Snapshot completo del scheduler — mismas keys que `RunSchedulerState`. */
  status: RunStatus;
  mode: SchedulerMode;
  phases: PhaseState[];
  batches: string[][];
  integrators: IntegratorState[];
  currentPhaseIndex: number;
  currentBatchIndex: number;
  currentStage: SequentialAgent | null;
  totals: { tokensIn: number; tokensOut: number; costUsd: number };
  byAgent: Record<LoopAgentRole, { tokensIn: number; tokensOut: number; costUsd: number }>;
  message: string | null;
  lastHeartbeat: number;
  settings: RunSettings | null;
}

// ---------------------------------------------------------------------------
// Serialización
// ---------------------------------------------------------------------------

/**
 * Construye el payload persistible a partir del estado del scheduler.
 * Sólo agrega `schemaVersion`; el resto pasa tal cual (las shapes coinciden).
 */
export function buildPersistedRunState(state: RunSchedulerState): PersistedRunState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: state.status,
    mode: state.mode,
    phases: state.phases,
    batches: state.batches,
    integrators: state.integrators,
    currentPhaseIndex: state.currentPhaseIndex,
    currentBatchIndex: state.currentBatchIndex,
    currentStage: state.currentStage,
    totals: state.totals,
    byAgent: state.byAgent,
    message: state.message,
    lastHeartbeat: state.lastHeartbeat,
    settings: state.settings,
  };
}

// ---------------------------------------------------------------------------
// Validator (runtime guard)
// ---------------------------------------------------------------------------

const RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "idle",
  "running",
  "paused",
  "completed",
  "aborted",
  "error",
] as const);

const STAGE_STATUSES: ReadonlySet<AgentStageStatus> = new Set([
  "pending",
  "running",
  "done",
  "warning",
  "error",
] as const);

const INTEGRATOR_STATUSES: ReadonlySet<IntegratorStatus> = new Set([
  "pending",
  "running",
  "done",
  "conflict",
  "error",
] as const);

const MODES: ReadonlySet<SchedulerMode> = new Set(["sequential", "hybrid"] as const);

const SEQUENTIAL_AGENT_NAMES: ReadonlyArray<SequentialAgent> = [
  "analysis",
  "implementation",
  "review",
  "knowledge",
];

const ALL_AGENT_NAMES: ReadonlyArray<LoopAgentRole> = [
  "analysis",
  "implementation",
  "review",
  "knowledge",
  "integration",
];

const LOOP_CLIS: ReadonlySet<LoopCli> = new Set(["claude", "codex", "opencode"] as const);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return isNumber(v) ? v : fallback;
}

function asNullableString(v: unknown): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : null;
}

function validateStage(value: unknown): AgentStageState | null {
  if (!isObj(value)) return null;
  if (typeof value.status !== "string" || !STAGE_STATUSES.has(value.status as AgentStageStatus)) {
    return null;
  }
  const stage: AgentStageState = {
    status: value.status as AgentStageStatus,
    tokensIn: asNumber(value.tokensIn),
    tokensOut: asNumber(value.tokensOut),
    costUsd: asNumber(value.costUsd),
    retries: asNumber(value.retries),
  };
  const message = asNullableString(value.message);
  if (message !== null) stage.message = message;
  return stage;
}

function validatePhase(value: unknown): PhaseState | null {
  if (!isObj(value)) return null;
  const slug = asString(value.slug);
  const id = asString(value.id);
  const name = asString(value.name);
  if (!slug || !id || !name) return null;
  if (typeof value.status !== "string" || !STAGE_STATUSES.has(value.status as AgentStageStatus)) {
    return null;
  }
  if (!isObj(value.stages)) return null;
  const stages: Record<SequentialAgent, AgentStageState> = {
    analysis: { status: "pending", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
    implementation: { status: "pending", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
    review: { status: "pending", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
    knowledge: { status: "pending", tokensIn: 0, tokensOut: 0, costUsd: 0, retries: 0 },
  };
  for (const agent of SEQUENTIAL_AGENT_NAMES) {
    const v = validateStage(value.stages[agent]);
    if (!v) return null;
    stages[agent] = v;
  }
  return {
    slug,
    id,
    name,
    status: value.status as AgentStageStatus,
    stages,
    reviewerExhausted: value.reviewerExhausted === true,
  };
}

function validateIntegrator(value: unknown): IntegratorState | null {
  if (!isObj(value)) return null;
  const batchId = asString(value.batchId);
  if (!batchId) return null;
  if (
    typeof value.status !== "string" ||
    !INTEGRATOR_STATUSES.has(value.status as IntegratorStatus)
  ) {
    return null;
  }
  const conflicts = Array.isArray(value.conflicts)
    ? value.conflicts.filter((c): c is string => typeof c === "string")
    : [];
  const integrator: IntegratorState = {
    batchId,
    batchIndex: asNumber(value.batchIndex),
    status: value.status as IntegratorStatus,
    tokensIn: asNumber(value.tokensIn),
    tokensOut: asNumber(value.tokensOut),
    costUsd: asNumber(value.costUsd),
    conflicts,
  };
  const message = asNullableString(value.message);
  if (message !== null) integrator.message = message;
  return integrator;
}

function validateAgentSlot(value: unknown): AgentSlot | null {
  if (!isObj(value)) return null;
  const cli = asString(value.cli);
  const model = asString(value.model);
  if (!LOOP_CLIS.has(cli as LoopCli) || !model) return null;
  return { cli: cli as LoopCli, model };
}

function validateMatrix(value: unknown): ProfileMatrix | null {
  if (!isObj(value)) return null;
  const matrix: Partial<ProfileMatrix> = {};
  for (const role of ALL_AGENT_NAMES) {
    const slot = validateAgentSlot(value[role]);
    if (!slot) return null;
    matrix[role] = slot;
  }
  return matrix as ProfileMatrix;
}

function validateSettings(value: unknown): RunSettings | null {
  if (value === null) return null;
  if (!isObj(value)) return null;
  const projectPath = asString(value.projectPath);
  const runId = asString(value.runId);
  if (!projectPath || !runId) return null;
  const matrix = validateMatrix(value.matrix);
  if (!matrix) return null;
  const promptOverrides: Partial<Record<LoopPromptName, string>> = {};
  if (isObj(value.promptOverrides)) {
    for (const [k, v] of Object.entries(value.promptOverrides)) {
      if (typeof v === "string") {
        promptOverrides[k as LoopPromptName] = v;
      }
    }
  }
  return {
    projectPath,
    runId,
    matrix,
    promptOverrides,
    maxRetries: asNumber(value.maxRetries, 3),
    agentTimeoutSecs: asNumber(value.agentTimeoutSecs, 300),
  };
}

function validateTotals(value: unknown): {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
} | null {
  if (!isObj(value)) return null;
  return {
    tokensIn: asNumber(value.tokensIn),
    tokensOut: asNumber(value.tokensOut),
    costUsd: asNumber(value.costUsd),
  };
}

function validateByAgent(
  value: unknown,
): Record<LoopAgentRole, { tokensIn: number; tokensOut: number; costUsd: number }> | null {
  if (!isObj(value)) return null;
  const out: Partial<
    Record<LoopAgentRole, { tokensIn: number; tokensOut: number; costUsd: number }>
  > = {};
  for (const role of ALL_AGENT_NAMES) {
    const entry = value[role];
    if (!isObj(entry)) return null;
    out[role] = {
      tokensIn: asNumber(entry.tokensIn),
      tokensOut: asNumber(entry.tokensOut),
      costUsd: asNumber(entry.costUsd),
    };
  }
  return out as Record<LoopAgentRole, { tokensIn: number; tokensOut: number; costUsd: number }>;
}

/**
 * Valida y parsea un payload `state.json`. Devuelve `null` si:
 *  - el JSON es inválido,
 *  - el `schemaVersion` no matchea,
 *  - alguna sección crítica del shape rompe el contrato (ej. faltan stages).
 *
 * El frontend lo trata como "estado no recuperable, descartar y dejar al
 * usuario armar un run nuevo".
 */
export function validateRunState(value: unknown): PersistedRunState | null {
  if (!isObj(value)) return null;
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) return null;
  if (typeof value.status !== "string" || !RUN_STATUSES.has(value.status as RunStatus)) {
    return null;
  }
  if (typeof value.mode !== "string" || !MODES.has(value.mode as SchedulerMode)) return null;

  if (!Array.isArray(value.phases)) return null;
  const phases: PhaseState[] = [];
  for (const p of value.phases) {
    const v = validatePhase(p);
    if (!v) return null;
    phases.push(v);
  }

  if (!Array.isArray(value.batches)) return null;
  const batches: string[][] = [];
  for (const batch of value.batches) {
    if (!Array.isArray(batch)) return null;
    const inner: string[] = [];
    for (const slug of batch) {
      if (typeof slug !== "string") return null;
      inner.push(slug);
    }
    batches.push(inner);
  }

  if (!Array.isArray(value.integrators)) return null;
  const integrators: IntegratorState[] = [];
  for (const integ of value.integrators) {
    const v = validateIntegrator(integ);
    if (!v) return null;
    integrators.push(v);
  }

  const totals = validateTotals(value.totals);
  if (!totals) return null;
  const byAgent = validateByAgent(value.byAgent);
  if (!byAgent) return null;

  const currentStageRaw = value.currentStage;
  const currentStage: SequentialAgent | null =
    typeof currentStageRaw === "string" &&
    SEQUENTIAL_AGENT_NAMES.includes(currentStageRaw as SequentialAgent)
      ? (currentStageRaw as SequentialAgent)
      : null;

  const settings = validateSettings(value.settings);

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: value.status as RunStatus,
    mode: value.mode as SchedulerMode,
    phases,
    batches,
    integrators,
    currentPhaseIndex: asNumber(value.currentPhaseIndex, -1),
    currentBatchIndex: asNumber(value.currentBatchIndex, -1),
    currentStage,
    totals,
    byAgent,
    message: asNullableString(value.message),
    lastHeartbeat: asNumber(value.lastHeartbeat),
    settings,
  };
}

/**
 * Parsea un string JSON crudo del disco y aplica `validateRunState`. Devuelve
 * `null` si el JSON es inválido O si la estructura no matchea.
 */
export function parsePersistedRunState(raw: string): PersistedRunState | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateRunState(parsed);
}

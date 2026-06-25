// Section 9 — detección de runs interrumpidos y helpers de resume.
//
// Al abrir `/loop` sobre un project, el chrome llama `findInterruptedRun(...)`
// para detectar si hay un run vivo con heartbeat viejo. Si lo hay, monta un
// banner ("run interrumpido detectado · ¿retomar?") con dos acciones:
//   - retomar: descarta outputs parciales, hidrata el scheduler con el state
//     persistido, y arranca el ciclo desde el último agente incompleto.
//   - archivar: mueve `<run>/` a `<project>/.loop/archived/<run>/` y vuelve a
//     mostrar el flow normal (paso 1 vacío).
//
// El parseo/validación del state.json vive en `state-schema.ts`. Acá sólo
// orquestamos la invocación de los comandos Tauri.

import { invoke } from "@tauri-apps/api/core";

import { parsePersistedRunState, type PersistedRunState } from "./state-schema";

/**
 * Resumen mínimo de un run interrumpido devuelto por
 * `loop_list_interrupted_runs`. Coincide con `InterruptedRun` en Rust (camelCase
 * via serde rename).
 */
export interface InterruptedRunSummary {
  runId: string;
  /** Epoch ms del último heartbeat persistido. 0 si nunca hubo. */
  lastHeartbeat: number;
  /** Edad del heartbeat en milisegundos al momento del scan. */
  ageMs: number;
}

/**
 * Resultado de cargar el state.json de un run interrumpido para el banner. Si
 * el JSON es inválido o no matchea el schema, devolvemos `null` — el caller
 * debe archivar el run en lugar de intentar retomarlo.
 */
export interface InterruptedRunDetails {
  summary: InterruptedRunSummary;
  state: PersistedRunState;
}

/**
 * Lista runs interrumpidos del project. Pasa al backend el threshold de
 * staleness en ms (default 15s = N×3 con N=5s, lo elige el Rust si no se
 * pasa). En tests se puede subir el threshold para forzar/desactivar la
 * detección.
 */
export async function listInterruptedRuns(
  projectPath: string,
  staleThresholdMs?: number,
): Promise<InterruptedRunSummary[]> {
  return invoke<InterruptedRunSummary[]>("loop_list_interrupted_runs", {
    projectPath,
    staleThresholdMs: staleThresholdMs ?? null,
  });
}

/**
 * Lee + valida el `state.json` de un run para confirmar que es retomable.
 * Devuelve `null` si el JSON falta, no parsea, o no matchea el schema.
 */
export async function loadInterruptedRunDetails(
  projectPath: string,
  summary: InterruptedRunSummary,
): Promise<InterruptedRunDetails | null> {
  const raw = await invoke<string>("loop_read_state_file", {
    projectPath,
    runId: summary.runId,
  }).catch(() => "");
  if (!raw) return null;
  const state = parsePersistedRunState(raw);
  if (!state) return null;
  return { summary, state };
}

/**
 * Descarta outputs parciales (archivos `<agent>.md` sin `<agent>.diff` companion)
 * de un run. Devuelve la lista de paths borrados — útil para mostrar al usuario
 * qué se descartó.
 */
export async function discardPartialOutputs(projectPath: string, runId: string): Promise<string[]> {
  return invoke<string[]>("loop_discard_partial_outputs", {
    projectPath,
    runId,
  });
}

/**
 * Archiva un run interrumpido: mueve `<project>/.loop/runs/<id>/` a
 * `<project>/.loop/archived/<id>/`. Devuelve el path destino.
 */
export async function archiveRun(projectPath: string, runId: string): Promise<string> {
  return invoke<string>("loop_archive_run", {
    projectPath,
    runId,
  });
}

/**
 * Decide la "primera etapa pendiente" desde un state hidratado. El scheduler
 * arranca su ciclo desde `currentPhaseIndex`, pero después de descartar
 * outputs parciales algunos stages "done" pueden quedar inconsistentes con el
 * disco — en ese caso conviene degradar el stage al primer `pending`.
 *
 * Estrategia conservadora: si la etapa `currentStage` quedó en `running` al
 * momento del crash, la degradamos a `pending`. El scheduler la va a relanzar
 * cuando arranque el ciclo. Otros stages "done" se preservan (sus outputs ya
 * tienen su `.diff` companion, no fueron borrados).
 */
export function rewindRunningStages(state: PersistedRunState): PersistedRunState {
  const phases = state.phases.map((p) => {
    const stages = { ...p.stages };
    let downgraded = false;
    for (const agent of ["analysis", "implementation", "review", "knowledge"] as const) {
      if (stages[agent].status === "running") {
        stages[agent] = { ...stages[agent], status: "pending", message: undefined };
        downgraded = true;
      }
    }
    if (!downgraded) return p;
    // Si bajamos algún stage a pending, la fase agregada vuelve a "pending"
    // también — el scheduler la va a recomputar al terminar.
    return { ...p, stages, status: "pending" as const };
  });
  // Integradores en `running` también vuelven a `pending`. Su knowledge.md
  // parcial puede haber quedado en disco (no lo borramos porque
  // `discard_partial_outputs` excluye el batches/ subdir), pero el scheduler
  // lo va a sobrescribir cuando re-ejecute.
  const integrators = state.integrators.map((i) =>
    i.status === "running" ? { ...i, status: "pending" as const, message: undefined } : i,
  );
  return {
    ...state,
    phases,
    integrators,
    currentStage: null,
    status: "paused",
    message: "run retomado desde un crash · iniciando reintento",
  };
}

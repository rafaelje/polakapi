// Engine del paso 3: scheduler que orquesta el pipeline por fase.
//
// Diseño general (alineado con design.md decisión #1 "contrato vía archivos en
// disco" y #4 "cap del revisor en 3"):
//
// - El run consta de N fases (de `02-phases.md`).
//   - En modo `sequential` las procesamos en el orden topológico que devuelve
//     `topologicalBatches` — flattenado a una lista lineal porque cada fase
//     tiene sus deps satisfechas cuando le toca el turno.
//   - En modo `hybrid` (Section 8) las procesamos por batches: cada batch
//     ejecuta sus fases en paralelo (`Promise.all`), y entre batch y batch
//     corre el agente integrador (5to agente) que consolida knowledge y
//     detecta conflictos de FS. Si el integrador marca blocker o el scheduler
//     detecta paths tocados por múltiples fases, el run se pausa esperando
//     decisión del usuario (continuar / re-ejecutar / abortar).
//
// - Pipeline por fase: análisis → implementación → revisor (≤ 3 tries) →
//   conocimiento. Cada paso:
//     1. snapshot del diff actual del project ("antes" del agente);
//     2. invoke run_loop_agent con el CLI/modelo del slot configurado y el
//        prompt del agente (de `<run>/prompts/<agent>.md`);
//     3. persiste `outputs/<phase>/<agent>.md` con result.text;
//     4. snapshot del diff de nuevo ("después") y diff_post - diff_pre se
//        guarda como `outputs/<phase>/<agent>.diff` (lo que el agente cambió
//        en el FS).
//     5. acumula tokens/cost en el budget del run y persiste `state.json`
//        con `lastHeartbeat`.
//
// - Cap del revisor: si después del 3er retry el revisor no aprueba, marcamos
//   la fase como `warning` y le inyectamos a `knowledge` un input adicional
//   con la deuda. El run sigue — design decisión #4.
//
// - El módulo expone `class RunScheduler` con un patrón consistente con
//   `LoopRouter` (listeners + getState + comandos start/pause/abort). NO
//   monta UI — el view layer (Section 7.7) consume `getState()` y se suscribe
//   con `on()`. Mantiene paridad con `src/modules/workspaces/state/workspaces-controller.ts`.
//
// - Pause: no kill mid-agent — el subproceso del CLI sigue hasta terminar (no
//   tenemos kill desde el wrapper actual; ver loop_cli.rs gotcha "kill del
//   subproceso colgado"). Cuando termina el agente actual, el scheduler ve
//   `pauseRequested=true` y se detiene antes del siguiente.
//
// - Abort: marca `aborted` y deja todo como está. El usuario puede retomar en
//   Section 9 (resume). NO borra los outputs ya persistidos — son auditables.

import { invoke } from "@tauri-apps/api/core";

import { topologicalBatches, type Phase } from "../step2-phases";
import { buildPersistedRunState, type PersistedRunState } from "./state-schema";
import type { AgentSlot, LoopAgentRole, LoopPromptName, ProfileMatrix } from "./types";

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

/**
 * Estado de una etapa (= un agente) dentro de una fase. Misma semántica que
 * el patrón usado en el design doc ("pending/running/done/warning").
 *
 * - `pending` : todavía no le tocó. Default al crear el state.
 * - `running` : el subproceso está en curso. Se setea antes de `invoke`
 *               y se quita al recibir la respuesta.
 * - `done`    : terminó OK y persistió su output.
 * - `warning` : completó pero con un caveat (ej. revisor no aprobó, knowledge
 *               recibió la deuda). El run sigue.
 * - `error`   : falló de manera no recuperable (ej. timeout, CLI no devolvió
 *               JSON parseable). El run se pone en pausa hasta que el usuario
 *               decida — design decisión #4 sólo cubre "revisor", no errores
 *               de infraestructura del CLI.
 */
export type AgentStageStatus = "pending" | "running" | "done" | "warning" | "error";

/** Las 4 etapas del pipeline secuencial — el integrador (5to agente) sólo en híbrido. */
export type SequentialAgent = "analysis" | "implementation" | "review" | "knowledge";

/** Estado de cada agente dentro de una fase. */
export interface AgentStageState {
  status: AgentStageStatus;
  /** Tokens consumidos hasta acá (suma de retries del revisor incluida). */
  tokensIn: number;
  tokensOut: number;
  /** Costo USD reportado por el CLI, si lo expuso. */
  costUsd: number;
  /** Cantidad de retries del revisor consumidos en esta fase (sólo aplica al revisor). */
  retries: number;
  /** Mensaje legible si el status es `warning` o `error`. */
  message?: string;
}

/** Estado de una fase del run. */
export interface PhaseState {
  slug: string;
  id: string;
  name: string;
  /** Status agregado: derivado de las 4 etapas pero precomputado para el view. */
  status: AgentStageStatus;
  /** Por-etapa: análisis, implementación, revisor, conocimiento. */
  stages: Record<SequentialAgent, AgentStageState>;
  /** Marcado cuando el revisor llegó al cap de 3 sin aprobar. Persistido en knowledge. */
  reviewerExhausted: boolean;
}

/** Configuración inmutable del run, snapshotada al ejecutar. */
export interface RunSettings {
  projectPath: string;
  runId: string;
  matrix: ProfileMatrix;
  /** Override del prompt por nombre (lo que el usuario editó en el setup). */
  promptOverrides: Partial<Record<LoopPromptName, string>>;
  /** Cap del revisor — design decision #4 fija 3 pero lo dejamos parametrizable para tests. */
  maxRetries: number;
  /** Timeout por invocación de agente (segundos). 300s default; el setup no lo expone aún. */
  agentTimeoutSecs: number;
}

/** Modo de ejecución del scheduler. `hybrid` corre fases por batches + integrador. */
export type SchedulerMode = "sequential" | "hybrid";

/** Status global del run. */
export type RunStatus =
  | "idle" // creado pero no arrancado
  | "running" // procesando una fase
  | "paused" // pausa solicitada y aplicada
  | "completed" // todas las fases done/warning
  | "aborted" // el usuario abortó
  | "error"; // un error inesperado paró el run

/**
 * Estado del integrador (5to agente) entre batches en modo híbrido. Cada
 * batch tiene un integrador propio que corre después de que terminan TODAS
 * las fases del batch. Section 8.3/8.4 le da el rol de consolidar knowledge
 * + detectar conflictos.
 *
 * - `pending`: el batch aún no terminó.
 * - `running`: el integrador está corriendo.
 * - `done`: terminó OK, no hay conflictos. El knowledge consolidado está en
 *           `<run>/outputs/batches/<batchId>/knowledge.md` y se pasa al
 *           siguiente batch como input adicional (Section 8.6).
 * - `conflict`: el integrador detectó conflictos (`INTEGRATION: blocker` en
 *               su output, o detección estructural por diff overlap). El run
 *               se pausa y el usuario decide (continuar / abortar / re-run).
 * - `error`: error de invocación del integrador.
 */
export type IntegratorStatus = "pending" | "running" | "done" | "conflict" | "error";

/** Estado del integrador para un batch específico. */
export interface IntegratorState {
  /** ID del batch: `batch-0`, `batch-1`, ... — usado como path en outputs. */
  batchId: string;
  /** Índice ordinal del batch (0-based). */
  batchIndex: number;
  status: IntegratorStatus;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /**
   * Lista de paths con conflicto si `status === "conflict"`. Útil para que el
   * UI muestre exactamente qué archivos rompen (Section 8.5).
   */
  conflicts: string[];
  /** Mensaje legible si está en `conflict`/`error`. */
  message?: string;
}

/** Snapshot completo del estado del scheduler. */
export interface RunSchedulerState {
  status: RunStatus;
  mode: SchedulerMode;
  /** Fases en orden de ejecución (flatten en sec; ordenadas por batch en híbrido). */
  phases: PhaseState[];
  /**
   * Batches del DAG cuando `mode === "hybrid"`. Cada entrada lista los `slug`
   * de las fases que corren en paralelo en ese batch. En modo secuencial este
   * array es vacío. Section 8.7 lo usa para la vista por batches.
   */
  batches: string[][];
  /** Estado del integrador por batch. Vacío en modo secuencial. */
  integrators: IntegratorState[];
  /** Índice de la fase que se está procesando (o que terminó última). */
  currentPhaseIndex: number;
  /** Índice del batch actual en modo híbrido. -1 antes de arrancar. */
  currentBatchIndex: number;
  /** Etapa que se está procesando dentro de la fase actual. null entre fases. */
  currentStage: SequentialAgent | null;
  /** Acumulado de tokens y USD para mostrar en el header del view. */
  totals: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  /** Acumulado por agente (rol completo, incluido integration). */
  byAgent: Record<LoopAgentRole, { tokensIn: number; tokensOut: number; costUsd: number }>;
  /** Mensaje global (último error, "pausa solicitada", etc.). */
  message: string | null;
  /** Heartbeat — ms epoch, se actualiza tras cada persist de state.json. */
  lastHeartbeat: number;
  /** Settings inmutables del run (snapshot del momento de arranque). */
  settings: RunSettings | null;
}

export type RunSchedulerListener = (state: RunSchedulerState) => void;

/**
 * Decisión del usuario al recibir el reporte de conflictos del integrador
 * (Section 8.5). El UI llama `scheduler.resolveConflict(decision)`.
 */
export type ConflictDecision = "continue" | "abort" | "rerun";

/** Resultado de `run_loop_agent` reflejado del backend (camelCase). */
interface AgentResult {
  text: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  sessionId?: string | null;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

const SEQUENTIAL_AGENTS: readonly SequentialAgent[] = [
  "analysis",
  "implementation",
  "review",
  "knowledge",
] as const;

const ALL_AGENT_ROLES: readonly LoopAgentRole[] = [
  "analysis",
  "implementation",
  "review",
  "knowledge",
  "integration",
] as const;

function createEmptyStage(): AgentStageState {
  return {
    status: "pending",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    retries: 0,
  };
}

function createPhaseState(phase: Phase, slug: string): PhaseState {
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

function createInitialState(): RunSchedulerState {
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

function createIntegratorState(batchIndex: number): IntegratorState {
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

/** ID determinístico del batch. Lo usamos como `batchId` para outputs. */
export function batchIdFor(index: number): string {
  return `batch-${index}`;
}

/**
 * Ordena fases linealmente respetando el DAG. Reusa `topologicalBatches` del
 * paso 2 — si todo el DAG es lineal cada batch tiene 1 fase y el flatten es
 * exacto. Si hay ramas paralelas, las procesamos en el orden del batch (no
 * importa el orden interno porque sus deps están en batches previos).
 */
export function sequentialPhaseOrder(phases: Phase[]): Phase[] | null {
  const batches = topologicalBatches(phases);
  if (!batches) return null;
  return batches.flat();
}

/** Slug igual al del paso 2 — duplicado por dependencia inversa. */
export function phaseToSlug(phase: Phase): string {
  const safeName = phase.name.replace(/[^A-Za-z0-9_-]/g, "-");
  return `${phase.id}-${safeName}`;
}

// ---------------------------------------------------------------------------
// Scheduler class
// ---------------------------------------------------------------------------

/**
 * Hooks para tests / depuración. En producción, todas las invocaciones pasan
 * por `invoke()` de `@tauri-apps/api`. En tests futuros (Section 11) podemos
 * pasar un harness alternativo que devuelva resultados deterministas.
 */
export interface SchedulerInvokers {
  runAgent(args: {
    cli: string;
    model: string;
    cwd: string;
    systemPromptPath: string | null;
    userInput: string;
    timeoutSecs: number;
  }): Promise<AgentResult>;
  readOutput(args: {
    projectPath: string;
    runId: string;
    phaseSlug: string;
    agent: SequentialAgent;
    ext: "md" | "diff";
  }): Promise<string>;
  writeOutput(args: {
    projectPath: string;
    runId: string;
    phaseSlug: string;
    agent: SequentialAgent;
    ext: "md" | "diff";
    content: string;
  }): Promise<void>;
  writeState(args: { projectPath: string; runId: string; content: string }): Promise<void>;
  gitDiffSnapshot(args: { projectPath: string }): Promise<string>;
  readPhaseFile(args: {
    projectPath: string;
    runId: string;
    phaseSlug: string;
    file: "logic.md" | "visual.html";
  }): Promise<string>;
  /** Section 8: read/write del knowledge consolidado por batch. */
  readBatchFile(args: {
    projectPath: string;
    runId: string;
    batchId: string;
    file: "knowledge.md";
  }): Promise<string>;
  writeBatchFile(args: {
    projectPath: string;
    runId: string;
    batchId: string;
    file: "knowledge.md";
    content: string;
  }): Promise<void>;
  /**
   * El path del prompt del run (`<run>/prompts/<name>`). Lo derivamos en el
   * caller con `buildRunPromptPath` (más abajo).
   */
}

/** Implementación default vía Tauri. */
const defaultInvokers: SchedulerInvokers = {
  runAgent: (args) => invoke<AgentResult>("run_loop_agent", args),
  readOutput: (args) => invoke<string>("loop_read_output_file", args),
  writeOutput: (args) => invoke<void>("loop_write_output_file", args),
  writeState: (args) => invoke<void>("loop_write_state_file", args),
  gitDiffSnapshot: (args) => invoke<string>("loop_git_diff_snapshot", args),
  readPhaseFile: (args) => invoke<string>("loop_read_phase_file", args),
  readBatchFile: (args) => invoke<string>("loop_read_batch_file", args),
  writeBatchFile: (args) => invoke<void>("loop_write_batch_file", args),
};

export class RunScheduler {
  private state: RunSchedulerState = createInitialState();
  private readonly listeners = new Set<RunSchedulerListener>();
  private readonly invokers: SchedulerInvokers;
  /**
   * Flag interno que el loop principal chequea entre etapas. Cuando es `true`
   * detenemos el scheduler antes de lanzar el próximo agente. NO mata
   * subprocesos en curso — para eso necesitaríamos hookear el child PID en el
   * wrapper Rust, que hoy no está expuesto.
   */
  private pauseRequested = false;
  private abortRequested = false;
  /** Promesa del ciclo principal — para await externo. */
  private cycle: Promise<void> | null = null;
  /**
   * Section 9.3 — timer del heartbeat. Lo arrancamos al entrar a un stage
   * (running) y lo paramos cuando el stage termina (o cuando el scheduler se
   * detiene). Actualiza `lastHeartbeat` cada `heartbeatIntervalMs` para que el
   * detector de "runs interrumpidos" pueda distinguir un proceso vivo de un
   * proceso muerto. Default 5s — design.md "Open Questions" deja ese valor.
   */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = 5000;

  constructor(invokers: SchedulerInvokers = defaultInvokers) {
    this.invokers = invokers;
  }

  getState(): RunSchedulerState {
    return this.state;
  }

  on(listener: RunSchedulerListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /**
   * Inicializa el scheduler con un set de fases ordenadas + settings, sin
   * arrancar la ejecución. Útil para mostrar la vista inicial con todo
   * `pending`. `mode` por defecto es `"sequential"` para compatibilidad con
   * los call-sites previos a Section 8.
   *
   * En modo `"hybrid"`:
   * - Calculamos batches con `topologicalBatches` (Kahn, Section 8.1).
   * - Cada batch genera su entrada en `state.integrators`.
   * - Las fases se ordenan por batch (preservando el orden interno de Kahn)
   *   para que `currentPhaseIndex` siga teniendo sentido en la vista plana.
   */
  initialize(phases: Phase[], settings: RunSettings, mode: SchedulerMode = "sequential"): void {
    const batchesByPhase = topologicalBatches(phases);
    if (!batchesByPhase) {
      this.commit({
        ...createInitialState(),
        status: "error",
        message: "hay un ciclo en las dependencias — no se puede ejecutar",
        settings,
      });
      return;
    }
    const ordered = batchesByPhase.flat();
    const phaseStates = ordered.map((p) => createPhaseState(p, phaseToSlug(p)));

    // Mapeo batch -> slugs (sólo poblado en modo hybrid; el view secuencial
    // lo ignora).
    const batches: string[][] =
      mode === "hybrid" ? batchesByPhase.map((batch) => batch.map((p) => phaseToSlug(p))) : [];
    const integrators: IntegratorState[] =
      mode === "hybrid" ? batches.map((_, i) => createIntegratorState(i)) : [];

    this.pauseRequested = false;
    this.abortRequested = false;
    this.conflictResolver = null;
    this.commit({
      ...createInitialState(),
      mode,
      phases: phaseStates,
      batches,
      integrators,
      settings,
      // En modo hybrid arrancamos en batchIndex 0; en sec se queda en -1.
      currentBatchIndex: mode === "hybrid" ? 0 : -1,
      lastHeartbeat: Date.now(),
    });
  }

  /**
   * Arranca el ciclo principal del scheduler. Resolves cuando el run termina
   * (completed/aborted/error/paused).
   */
  async start(): Promise<void> {
    if (this.state.status === "running") return;
    if (!this.state.settings) {
      this.commit({
        ...this.state,
        status: "error",
        message: "scheduler sin settings — llamá a initialize() primero",
      });
      return;
    }
    this.pauseRequested = false;
    this.abortRequested = false;
    this.commit({ ...this.state, status: "running", message: null });
    this.cycle = this.runCycle().catch((err: unknown) => {
      this.commit({
        ...this.state,
        status: "error",
        message: `error inesperado: ${stringifyError(err)}`,
      });
    });
    await this.cycle;
  }

  /**
   * Solicita pausa cooperativa. El agente en curso termina; antes del próximo
   * el scheduler verifica el flag y se detiene.
   */
  pause(): void {
    if (this.state.status !== "running") return;
    this.pauseRequested = true;
    this.commit({ ...this.state, message: "pausa solicitada — termina el agente actual" });
  }

  /**
   * Aborta el run. Mismo comportamiento que pause respecto al agente en curso,
   * pero al detenerse el status queda en `aborted` y no se puede reanudar
   * sin un nuevo `start()`.
   */
  abort(): void {
    if (this.state.status !== "running" && this.state.status !== "paused") return;
    this.abortRequested = true;
    this.pauseRequested = true;
    this.commit({ ...this.state, message: "abort solicitado — termina el agente actual" });
    // Si estamos esperando una decisión de conflict (Section 8.5), destrabamos
    // el await con "abort" para que el ciclo principal salga.
    if (this.conflictResolver) {
      const resolver = this.conflictResolver;
      this.conflictResolver = null;
      resolver("abort");
    }
    // El timer del heartbeat se detiene en `finalizeCycle()` cuando el agente
    // actual termine; lo dejamos vivo hasta entonces para que el run siga
    // reportando "vivo" al detector de runs interrumpidos.
  }

  /**
   * Section 8.5: el integrador detectó conflicto y el run está pausado. El
   * usuario debe decidir vía `resolveConflict()`. La promesa que el ciclo
   * principal `await`-ea queda colgada hasta entonces.
   *
   * - `continue`: aceptar el batch como está y seguir al próximo.
   * - `abort`: cortar el run.
   * - `rerun`: re-ejecutar el batch entero (todas las fases del batch vuelven a
   *   `pending` y se relanzan).
   */
  private conflictResolver: ((decision: ConflictDecision) => void) | null = null;

  /**
   * El usuario resuelve un conflicto reportado por el integrador. No-op si no
   * hay conflicto activo (status !== "paused" por integrador).
   */
  resolveConflict(decision: ConflictDecision): void {
    if (!this.conflictResolver) return;
    const resolver = this.conflictResolver;
    this.conflictResolver = null;
    resolver(decision);
  }

  // -------------------------------------------------------------------------
  // Ciclo principal — dispatch entre modo secuencial e híbrido
  // -------------------------------------------------------------------------

  private async runCycle(): Promise<void> {
    if (this.state.mode === "hybrid") {
      await this.runHybridCycle();
    } else {
      await this.runSequentialCycle();
    }
  }

  private async runSequentialCycle(): Promise<void> {
    const startIndex = Math.max(0, this.state.currentPhaseIndex);
    for (let i = startIndex; i < this.state.phases.length; i++) {
      if (this.shouldStop()) break;
      this.updatePhaseIndex(i);
      await this.runPhase(i);
    }
    this.finalizeCycle();
    await this.persistState();
  }

  /**
   * Section 8: ciclo del modo híbrido.
   *
   * Para cada batch:
   *   1. Lanzar todas las fases del batch en paralelo (`Promise.all` sobre
   *      `runPhase` — section 8.2). El pipeline interno de cada fase (análisis →
   *      impl → revisor → conocimiento) se ejecuta de manera independiente.
   *      Como el contrato entre agentes es por archivos en disco (design
   *      decision #1) y cada fase escribe a su propio `phases/<slug>/`, no hay
   *      acoplamiento intra-batch.
   *   2. Esperar a que las fases del batch terminen (ok, warning o error).
   *   3. Detectar conflictos de FS entre las fases del batch (section 8.4):
   *      parsear los `*.diff` de implementación y ver si dos fases tocan el
   *      mismo path.
   *   4. Correr el integrador (5to agente) sobre los outputs del batch
   *      (section 8.3). Output a `<run>/outputs/batches/batch-N/knowledge.md`.
   *   5. Si el integrador o el detector estructural marcan conflict, pausar
   *      hasta que el usuario decida (section 8.5).
   *
   * El knowledge consolidado del batch N queda disponible para las fases del
   * batch N+1 vía `buildAgentInput` que lo lee desde disco (section 8.6).
   */
  private async runHybridCycle(): Promise<void> {
    let batchIndex = Math.max(0, this.state.currentBatchIndex);
    while (batchIndex < this.state.batches.length) {
      if (this.shouldStop()) break;
      this.commit({ ...this.state, currentBatchIndex: batchIndex });

      // 1. Lanzar las fases del batch en paralelo.
      const slugs = this.state.batches[batchIndex];
      const phaseIndices = slugs
        .map((slug) => this.state.phases.findIndex((p) => p.slug === slug))
        .filter((i) => i >= 0);
      if (phaseIndices.length === 0) {
        batchIndex += 1;
        continue;
      }

      // Reset de retries/status sólo cuando el batch arranca limpio (no resume).
      // El resume formal (Section 9) puede preservar los stages done; acá si el
      // batch arranca todas sus fases tienen que estar en pending (lo están al
      // inicializar) o resetadas (al re-run vía `resolveConflict("rerun")`).

      await Promise.all(phaseIndices.map((idx) => this.runPhase(idx)));

      if (this.shouldStop()) break;
      // Si alguna fase del batch terminó en `error` fatal, no corremos integrador
      // y dejamos el run en error.
      const anyError = phaseIndices.some((i) => this.state.phases[i].status === "error");
      if (anyError || this.state.status === "error") {
        // runPhase ya seteó el message en este caso.
        break;
      }

      // 2. Correr integrador. Devuelve conflicts detectados (estructurales +
      //    los que el agente marcó con `INTEGRATION: blocker`).
      const integratorOutcome = await this.runIntegrator(batchIndex, phaseIndices);
      if (this.shouldStop()) break;
      if (integratorOutcome === "error") {
        // Marcamos el run en error y dejamos al usuario inspeccionar el state.
        this.commit({
          ...this.state,
          status: "error",
          message: `integrador batch-${batchIndex} falló — ver outputs/batches/${batchIdFor(batchIndex)}/`,
        });
        break;
      }

      if (integratorOutcome === "conflict") {
        // 3. Conflict: pausamos y esperamos al usuario. La decisión llega vía
        //    `resolveConflict()` (Section 8.5).
        const decision = await this.awaitConflictDecision(batchIndex);
        if (decision === "abort") {
          this.abortRequested = true;
          break;
        }
        if (decision === "rerun") {
          this.resetBatchPhases(phaseIndices);
          this.patchIntegrator(batchIndex, {
            status: "pending",
            conflicts: [],
            message: undefined,
          });
          this.commit({ ...this.state, status: "running", message: null });
          // Sigue el while loop con el mismo batchIndex.
          continue;
        }
        // decision === "continue": tratamos el integrador como done y avanzamos.
        this.patchIntegrator(batchIndex, {
          status: "done",
          message: "conflictos aceptados por el usuario — el flow continúa",
        });
        this.commit({ ...this.state, status: "running", message: null });
      }

      batchIndex += 1;
    }
    this.finalizeCycle();
    await this.persistState();
  }

  /**
   * Cierre del ciclo principal (común a sec/híbrido). Decide el status final
   * del run según los flags pendientes.
   */
  private finalizeCycle(): void {
    this.stopHeartbeat();
    if (this.abortRequested) {
      this.commit({ ...this.state, status: "aborted", currentStage: null });
    } else if (this.pauseRequested) {
      this.commit({ ...this.state, status: "paused", currentStage: null });
    } else if (this.state.status === "error") {
      // El error ya seteó el message.
    } else {
      this.commit({ ...this.state, status: "completed", currentStage: null });
    }
  }

  private async runPhase(index: number): Promise<void> {
    const settings = this.state.settings;
    if (!settings) return;
    const phase = this.state.phases[index];
    if (!phase) return;

    // Ejecutamos las 4 etapas en orden. Cada etapa puede setear `warning` o
    // `error` y el scheduler reacciona al final.
    for (const agent of SEQUENTIAL_AGENTS) {
      if (this.shouldStop()) return;
      if (agent === "review") {
        await this.runReviewLoop(index);
      } else {
        await this.runStage(index, agent);
      }
      // Si la etapa terminó en error fatal, detenemos el ciclo y dejamos el
      // run en `error`. El usuario puede inspeccionar y eventualmente
      // retomar (Section 9).
      const stage = this.state.phases[index].stages[agent];
      if (stage.status === "error") {
        this.commit({
          ...this.state,
          status: "error",
          message: `fase ${phase.slug} / ${agent}: ${stage.message ?? "error desconocido"}`,
        });
        return;
      }
    }
    // Cuando todas las etapas terminaron, agregamos el status global de la
    // fase. Si alguna quedó en warning, la fase es warning.
    const stages = this.state.phases[index].stages;
    const anyWarning =
      stages.analysis.status === "warning" ||
      stages.implementation.status === "warning" ||
      stages.review.status === "warning" ||
      stages.knowledge.status === "warning";
    this.patchPhase(index, {
      status: anyWarning ? "warning" : "done",
    });
    await this.persistState();
  }

  /**
   * Loop del revisor con cap de retries. Cada retry rehace implementación +
   * review hasta que el revisor apruebe o lleguemos al cap. Al cap, marcamos
   * la fase como `warning` (reviewerExhausted=true) y seguimos al
   * conocimiento — design decision #4.
   */
  private async runReviewLoop(phaseIndex: number): Promise<void> {
    const settings = this.state.settings;
    if (!settings) return;
    let attempt = 0;
    while (attempt < settings.maxRetries) {
      if (this.shouldStop()) return;
      attempt += 1;
      this.patchStage(phaseIndex, "review", { retries: attempt });
      const verdict = await this.runStage(phaseIndex, "review");
      // Para `review`, runStage devuelve { approved, notes } o null (error).
      // El `undefined` sólo aplica a stages no-review — defensivo igualmente.
      if (!verdict) {
        // Error fatal del revisor (no llegamos a parsear veredicto).
        return;
      }
      if (verdict.approved) {
        this.patchStage(phaseIndex, "review", { status: "done" });
        return;
      }
      // Veredicto = retry. Si quedan intentos, re-corremos implementación con
      // las notas del revisor como input adicional.
      if (attempt < settings.maxRetries) {
        if (this.shouldStop()) return;
        await this.runStage(phaseIndex, "implementation", { reviewNotes: verdict.notes });
      }
    }
    // Cap alcanzado sin aprobar.
    this.patchPhase(phaseIndex, { reviewerExhausted: true });
    this.patchStage(phaseIndex, "review", {
      status: "warning",
      message: "revisor no aprobó tras 3 intentos — deuda anotada en knowledge",
    });
  }

  /**
   * Ejecuta una etapa individual del pipeline. Encapsula:
   *   - diff snapshot antes
   *   - invoke run_loop_agent
   *   - persistencia de outputs/<phase>/<agent>.md y .diff
   *   - actualización de tokens/cost/status
   *
   * `extraInputs.reviewNotes` permite a `runReviewLoop` pasar las notas del
   * revisor al implementador en el retry.
   *
   * Devuelve para `review` un objeto `{ approved, notes }` extraído del
   * veredicto del CLI; para los demás devuelve undefined.
   */
  private async runStage(
    phaseIndex: number,
    agent: SequentialAgent,
    extras?: { reviewNotes?: string },
  ): Promise<{ approved: boolean; notes: string } | null | undefined> {
    const settings = this.state.settings;
    if (!settings) return null;
    const phase = this.state.phases[phaseIndex];
    if (!phase) return null;

    this.updateCurrentStage(agent);
    this.patchStage(phaseIndex, agent, { status: "running", message: undefined });

    // 1. Snapshot del diff antes del agente. Si falla, no es fatal — guardamos
    //    string vacío y seguimos.
    const diffBefore = await this.invokers
      .gitDiffSnapshot({ projectPath: settings.projectPath })
      .catch(() => "");

    // 2. Armar el user input del agente. El system prompt va por path; los
    //    inputs específicos (logic.md, knowledge de fase previa, etc.) viajan
    //    en el body.
    const userInput = await this.buildAgentInput(phaseIndex, agent, extras);

    const slot = this.slotForAgent(agent);
    const systemPromptPath = buildRunPromptPath(
      settings.projectPath,
      settings.runId,
      `${agent}.md` as LoopPromptName,
    );

    // 3. Invoke. Tracker de tiempo + error normalization. El heartbeat timer
    //    pulsa `lastHeartbeat` cada 5s mientras el CLI está corriendo (Section
    //    9.3) — sin esto el detector de runs interrumpidos podría confundir un
    //    agente lento con un crash.
    let result: AgentResult;
    this.startHeartbeat();
    try {
      result = await this.invokers.runAgent({
        cli: slot.cli,
        model: slot.model,
        cwd: settings.projectPath,
        systemPromptPath,
        userInput,
        timeoutSecs: settings.agentTimeoutSecs,
      });
    } catch (err) {
      this.stopHeartbeat();
      this.patchStage(phaseIndex, agent, {
        status: "error",
        message: `error invocando agente: ${stringifyError(err)}`,
      });
      await this.persistState();
      return null;
    }
    this.stopHeartbeat();

    if (result.error) {
      this.patchStage(phaseIndex, agent, {
        status: "error",
        message: result.error,
      });
      await this.persistState();
      return null;
    }

    // 4. Acumular tokens/cost en la etapa y en los totales del run.
    const tokensIn = result.tokensIn ?? 0;
    const tokensOut = result.tokensOut ?? 0;
    const costUsd = result.costUsd ?? 0;
    this.patchStage(phaseIndex, agent, {
      tokensIn: phase.stages[agent].tokensIn + tokensIn,
      tokensOut: phase.stages[agent].tokensOut + tokensOut,
      costUsd: phase.stages[agent].costUsd + costUsd,
    });
    const role: LoopAgentRole = agent;
    this.commit({
      ...this.state,
      totals: {
        tokensIn: this.state.totals.tokensIn + tokensIn,
        tokensOut: this.state.totals.tokensOut + tokensOut,
        costUsd: this.state.totals.costUsd + costUsd,
      },
      byAgent: {
        ...this.state.byAgent,
        [role]: {
          tokensIn: this.state.byAgent[role].tokensIn + tokensIn,
          tokensOut: this.state.byAgent[role].tokensOut + tokensOut,
          costUsd: this.state.byAgent[role].costUsd + costUsd,
        },
      },
    });

    // 5. Persistir output md.
    try {
      await this.invokers.writeOutput({
        projectPath: settings.projectPath,
        runId: settings.runId,
        phaseSlug: phase.slug,
        agent,
        ext: "md",
        content: result.text,
      });
    } catch (err) {
      this.patchStage(phaseIndex, agent, {
        status: "error",
        message: `no pude persistir output: ${stringifyError(err)}`,
      });
      await this.persistState();
      return null;
    }

    // 6. Snapshot del diff después y persist diff = after (es snapshot
    //    diferencial respecto a HEAD; el "antes" sirve sólo para auditoría si
    //    el agente escribió encima de cambios pre-existentes — la diferencia
    //    real está en el diff after, que captura todo desde HEAD).
    const diffAfter = await this.invokers
      .gitDiffSnapshot({ projectPath: settings.projectPath })
      .catch(() => "");
    const diffCombined = buildAgentDiff(diffBefore, diffAfter);
    try {
      await this.invokers.writeOutput({
        projectPath: settings.projectPath,
        runId: settings.runId,
        phaseSlug: phase.slug,
        agent,
        ext: "diff",
        content: diffCombined,
      });
    } catch (err) {
      // No es fatal — el output md ya está. Logueamos y seguimos.
      console.error("loop scheduler: no pude persistir diff", err);
    }

    // 7. Si la etapa no es revisor, marcamos done y persistimos state.
    if (agent !== "review") {
      this.patchStage(phaseIndex, agent, { status: "done" });
      await this.persistState();
      return undefined;
    }

    // Revisor: parsear veredicto y devolverlo al loop.
    const parsed = parseReviewVerdict(result.text);
    if (parsed.approved) {
      // Done lo setea el caller (runReviewLoop) para reflejar el cap correctamente.
    }
    await this.persistState();
    return parsed;
  }

  /**
   * Arma el user input que se le pasa al agente. Cada agente recibe distintos
   * archivos como contexto. Los reads tolerantes a "no existe aún" (read
   * vacío) — design decision #1 hace que el contrato sea por archivos en
   * disco, no por orden temporal.
   */
  private async buildAgentInput(
    phaseIndex: number,
    agent: SequentialAgent,
    extras?: { reviewNotes?: string },
  ): Promise<string> {
    const settings = this.state.settings;
    if (!settings) return "";
    const phase = this.state.phases[phaseIndex];
    // En modo secuencial, "fase previa" es phaseIndex - 1 (orden topológico
    // flattenado). En modo híbrido las fases del mismo batch corren en
    // paralelo: no podemos leer knowledge entre fases del mismo batch porque
    // probablemente todavía no exista; en su lugar inyectamos el knowledge
    // consolidado del batch previo (Section 8.6) más abajo.
    const prevPhase =
      this.state.mode === "sequential" && phaseIndex > 0 ? this.state.phases[phaseIndex - 1] : null;

    // Inputs comunes: logic.md de la fase + knowledge.md de la fase previa
    // (secuencial) o del batch previo (híbrido).
    const batchIndex = this.batchIndexForPhase(phase.slug);
    const prevBatchKnowledgePromise =
      this.state.mode === "hybrid" && batchIndex > 0
        ? this.invokers
            .readBatchFile({
              projectPath: settings.projectPath,
              runId: settings.runId,
              batchId: batchIdFor(batchIndex - 1),
              file: "knowledge.md",
            })
            .catch(() => "")
        : Promise.resolve("");

    const [logic, prevKnowledge, prevBatchKnowledge] = await Promise.all([
      this.invokers
        .readPhaseFile({
          projectPath: settings.projectPath,
          runId: settings.runId,
          phaseSlug: phase.slug,
          file: "logic.md",
        })
        .catch(() => ""),
      prevPhase
        ? this.invokers
            .readOutput({
              projectPath: settings.projectPath,
              runId: settings.runId,
              phaseSlug: prevPhase.slug,
              agent: "knowledge",
              ext: "md",
            })
            .catch(() => "")
        : Promise.resolve(""),
      prevBatchKnowledgePromise,
    ]);

    const parts: string[] = [];
    parts.push(`# Fase ${phase.id} · ${phase.name}\n`);
    parts.push("## logic.md\n");
    parts.push(logic.trim() || "(vacío)");
    parts.push("\n");

    if (prevKnowledge.trim()) {
      parts.push(`## Knowledge de la fase previa (${prevPhase?.name ?? ""})\n`);
      parts.push(prevKnowledge.trim());
      parts.push("\n");
    }

    if (prevBatchKnowledge.trim()) {
      parts.push(`## Knowledge consolidado del batch previo (batch-${batchIndex - 1})\n`);
      parts.push(prevBatchKnowledge.trim());
      parts.push("\n");
    }

    if (agent === "implementation" || agent === "review" || agent === "knowledge") {
      const analysis = await this.invokers
        .readOutput({
          projectPath: settings.projectPath,
          runId: settings.runId,
          phaseSlug: phase.slug,
          agent: "analysis",
          ext: "md",
        })
        .catch(() => "");
      if (analysis.trim()) {
        parts.push("## analysis.md\n");
        parts.push(analysis.trim());
        parts.push("\n");
      }
    }

    if (agent === "review" || agent === "knowledge") {
      const impl = await this.invokers
        .readOutput({
          projectPath: settings.projectPath,
          runId: settings.runId,
          phaseSlug: phase.slug,
          agent: "implementation",
          ext: "md",
        })
        .catch(() => "");
      const implDiff = await this.invokers
        .readOutput({
          projectPath: settings.projectPath,
          runId: settings.runId,
          phaseSlug: phase.slug,
          agent: "implementation",
          ext: "diff",
        })
        .catch(() => "");
      if (impl.trim()) {
        parts.push("## implementation.md\n");
        parts.push(impl.trim());
        parts.push("\n");
      }
      if (implDiff.trim()) {
        parts.push("## implementation.diff\n");
        parts.push("```diff\n");
        parts.push(implDiff.trim());
        parts.push("\n```\n");
      }
    }

    if (agent === "knowledge") {
      const review = await this.invokers
        .readOutput({
          projectPath: settings.projectPath,
          runId: settings.runId,
          phaseSlug: phase.slug,
          agent: "review",
          ext: "md",
        })
        .catch(() => "");
      if (review.trim()) {
        parts.push("## review.md\n");
        parts.push(review.trim());
        parts.push("\n");
      }
      if (phase.reviewerExhausted) {
        parts.push("## DEUDA TÉCNICA\n");
        parts.push(
          "El revisor no aprobó tras 3 intentos. Esta fase queda con `warning` propagado.\n" +
            "Anotá explícitamente en tu output `knowledge.md` qué quedó sin resolver y qué tendría que cubrir manualmente el usuario o una fase posterior.\n",
        );
      }
    }

    if (extras?.reviewNotes && agent === "implementation") {
      parts.push("## Notas del revisor del intento anterior\n");
      parts.push(extras.reviewNotes.trim());
      parts.push("\n\nAtendé estas notas antes de devolver el output.\n");
    }

    return parts.join("\n");
  }

  // -------------------------------------------------------------------------
  // Section 8: integrador y conflictos
  // -------------------------------------------------------------------------

  /**
   * Corre el integrador para el batch dado. Pasos:
   *
   *   1. Leer todos los `knowledge.md` + `implementation.diff` de las fases del
   *      batch. Se concatenan en el user input del integrador (prompt seed:
   *      `integration.md`).
   *   2. Detectar conflictos estructurales: paths tocados por más de una fase
   *      del batch (parseamos los diffs por sus headers `diff --git`).
   *   3. Invocar `run_loop_agent` con el slot del rol `integration`.
   *   4. Persistir el output en `<run>/outputs/batches/batch-N/knowledge.md`.
   *   5. Parsear el veredicto final del integrador (`INTEGRATION: ok|blocker`).
   *      Si está en `blocker` o si hay conflictos estructurales, el outcome es
   *      `conflict`. Si no, `done`.
   *
   * Retorna `"done" | "conflict" | "error"` para que `runHybridCycle` decida si
   * sigue, pausa o aborta.
   */
  private async runIntegrator(
    batchIndex: number,
    phaseIndices: number[],
  ): Promise<"done" | "conflict" | "error"> {
    const settings = this.state.settings;
    if (!settings) return "error";

    this.patchIntegrator(batchIndex, { status: "running", message: undefined });
    this.commit({ ...this.state, currentStage: null });

    // 1. Leer outputs/diffs del batch.
    const phasesOfBatch = phaseIndices
      .map((i) => this.state.phases[i])
      .filter((p): p is PhaseState => Boolean(p));
    const reads = await Promise.all(
      phasesOfBatch.map(async (phase) => {
        const [knowledge, implDiff, implMd] = await Promise.all([
          this.invokers
            .readOutput({
              projectPath: settings.projectPath,
              runId: settings.runId,
              phaseSlug: phase.slug,
              agent: "knowledge",
              ext: "md",
            })
            .catch(() => ""),
          this.invokers
            .readOutput({
              projectPath: settings.projectPath,
              runId: settings.runId,
              phaseSlug: phase.slug,
              agent: "implementation",
              ext: "diff",
            })
            .catch(() => ""),
          this.invokers
            .readOutput({
              projectPath: settings.projectPath,
              runId: settings.runId,
              phaseSlug: phase.slug,
              agent: "implementation",
              ext: "md",
            })
            .catch(() => ""),
        ]);
        return { phase, knowledge, implDiff, implMd };
      }),
    );

    // 2. Detección estructural de conflictos (Section 8.4): paths tocados por
    //    múltiples fases del batch.
    const conflictsByPath = detectBatchConflicts(
      reads.map(({ phase, implDiff }) => ({
        phaseSlug: phase.slug,
        phaseName: phase.name,
        diff: implDiff,
      })),
    );

    // 3. Armar user input para el integrador.
    const parts: string[] = [];
    parts.push(`# Integrador del batch ${batchIdFor(batchIndex)}\n`);
    parts.push(
      `Hay ${phasesOfBatch.length} fase(s) en este batch. Tu trabajo: consolidar el knowledge y detectar conflictos.\n`,
    );
    for (const { phase, knowledge, implDiff, implMd } of reads) {
      parts.push(`\n## Fase ${phase.id} · ${phase.name}\n`);
      if (knowledge.trim()) {
        parts.push("### knowledge.md\n");
        parts.push(knowledge.trim());
        parts.push("\n");
      } else {
        parts.push("### knowledge.md\n(sin contenido — la fase no produjo conocimiento o falló)\n");
      }
      if (implMd.trim()) {
        parts.push("### implementation.md (resumen)\n");
        parts.push(truncateForIntegrator(implMd));
        parts.push("\n");
      }
      if (implDiff.trim()) {
        parts.push("### implementation.diff\n");
        parts.push("```diff\n");
        parts.push(truncateForIntegrator(implDiff));
        parts.push("\n```\n");
      }
    }
    if (conflictsByPath.length > 0) {
      parts.push("\n## Conflictos estructurales detectados por el scheduler\n");
      parts.push(
        "Los siguientes paths fueron modificados por más de una fase del batch — revisalos y marcá `BLOCKER` si rompen coherencia:\n",
      );
      for (const c of conflictsByPath) {
        parts.push(`- \`${c.path}\` — fases: ${c.phases.join(", ")}\n`);
      }
    }

    const userInput = parts.join("\n");
    const slot = this.slotForAgent("integration");
    const systemPromptPath = buildRunPromptPath(
      settings.projectPath,
      settings.runId,
      "integration.md",
    );

    // 4. Invocar al integrador. Heartbeat pulsa durante la corrida (Section 9.3).
    let result: AgentResult;
    this.startHeartbeat();
    try {
      result = await this.invokers.runAgent({
        cli: slot.cli,
        model: slot.model,
        cwd: settings.projectPath,
        systemPromptPath,
        userInput,
        timeoutSecs: settings.agentTimeoutSecs,
      });
    } catch (err) {
      this.stopHeartbeat();
      this.patchIntegrator(batchIndex, {
        status: "error",
        message: `error invocando integrador: ${stringifyError(err)}`,
      });
      await this.persistState();
      return "error";
    }
    this.stopHeartbeat();
    if (result.error) {
      this.patchIntegrator(batchIndex, {
        status: "error",
        message: result.error,
      });
      await this.persistState();
      return "error";
    }

    // 5. Acumular tokens/cost del integrador.
    const tokensIn = result.tokensIn ?? 0;
    const tokensOut = result.tokensOut ?? 0;
    const costUsd = result.costUsd ?? 0;
    this.patchIntegrator(batchIndex, {
      tokensIn: this.state.integrators[batchIndex].tokensIn + tokensIn,
      tokensOut: this.state.integrators[batchIndex].tokensOut + tokensOut,
      costUsd: this.state.integrators[batchIndex].costUsd + costUsd,
    });
    this.commit({
      ...this.state,
      totals: {
        tokensIn: this.state.totals.tokensIn + tokensIn,
        tokensOut: this.state.totals.tokensOut + tokensOut,
        costUsd: this.state.totals.costUsd + costUsd,
      },
      byAgent: {
        ...this.state.byAgent,
        integration: {
          tokensIn: this.state.byAgent.integration.tokensIn + tokensIn,
          tokensOut: this.state.byAgent.integration.tokensOut + tokensOut,
          costUsd: this.state.byAgent.integration.costUsd + costUsd,
        },
      },
    });

    // 6. Persistir output.
    try {
      await this.invokers.writeBatchFile({
        projectPath: settings.projectPath,
        runId: settings.runId,
        batchId: batchIdFor(batchIndex),
        file: "knowledge.md",
        content: result.text,
      });
    } catch (err) {
      this.patchIntegrator(batchIndex, {
        status: "error",
        message: `no pude persistir knowledge consolidado: ${stringifyError(err)}`,
      });
      await this.persistState();
      return "error";
    }

    // 7. Parsear veredicto. Si el agente marca blocker, conflict. Si el
    //    detector estructural encontró paths conflict y el agente no los
    //    descartó explícitamente con `INTEGRATION: ok`, tratamos como conflict
    //    (lado conservador — design risk "integrador del batch hace ... antes
    //    de aprobar").
    const verdict = parseIntegrationVerdict(result.text);
    const conflictPaths = conflictsByPath.map((c) => c.path);
    const isBlocker =
      verdict.status === "blocker" || (conflictPaths.length > 0 && verdict.status !== "ok");

    if (isBlocker) {
      this.patchIntegrator(batchIndex, {
        status: "conflict",
        conflicts: conflictPaths,
        message:
          verdict.status === "blocker"
            ? "integrador marcó BLOCKER — revisá el knowledge consolidado"
            : "el scheduler detectó paths tocados por múltiples fases — revisá el knowledge",
      });
      await this.persistState();
      return "conflict";
    }

    this.patchIntegrator(batchIndex, {
      status: "done",
      conflicts: conflictPaths, // info para el usuario aunque no rompa
      message: undefined,
    });
    await this.persistState();
    return "done";
  }

  /**
   * Pausa el ciclo hasta que el usuario decida vía `resolveConflict`. Mientras
   * tanto el status global es "paused" y los listeners pueden refrescar el
   * view con la card del integrador en estado "conflict".
   */
  private awaitConflictDecision(batchIndex: number): Promise<ConflictDecision> {
    this.commit({
      ...this.state,
      status: "paused",
      message: `conflicto en batch-${batchIndex} — decidí continuar, abortar o re-ejecutar`,
    });
    return new Promise<ConflictDecision>((resolve) => {
      this.conflictResolver = resolve;
    });
  }

  /**
   * Resetea el estado de las fases del batch a `pending` y limpia sus stages.
   * Usado al re-ejecutar tras una decisión de conflict.
   */
  private resetBatchPhases(phaseIndices: number[]): void {
    const phases = this.state.phases.slice();
    for (const idx of phaseIndices) {
      const p = phases[idx];
      if (!p) continue;
      phases[idx] = {
        ...p,
        status: "pending",
        reviewerExhausted: false,
        stages: {
          analysis: createEmptyStage(),
          implementation: createEmptyStage(),
          review: createEmptyStage(),
          knowledge: createEmptyStage(),
        },
      };
    }
    this.commit({ ...this.state, phases });
  }

  private patchIntegrator(batchIndex: number, patch: Partial<IntegratorState>): void {
    const integrators = this.state.integrators.slice();
    const current = integrators[batchIndex];
    if (!current) return;
    integrators[batchIndex] = { ...current, ...patch };
    this.commit({ ...this.state, integrators });
  }

  // -------------------------------------------------------------------------
  // Helpers internos
  // -------------------------------------------------------------------------

  private shouldStop(): boolean {
    return this.pauseRequested || this.abortRequested;
  }

  private slotForAgent(agent: LoopAgentRole): AgentSlot {
    const matrix = this.state.settings?.matrix;
    if (!matrix) return { cli: "claude", model: "claude-opus-4-7" };
    return matrix[agent];
  }

  /**
   * Devuelve el índice del batch al que pertenece una fase. -1 si la fase no
   * está en ningún batch (modo secuencial o slug no listado).
   */
  private batchIndexForPhase(slug: string): number {
    if (this.state.mode !== "hybrid") return -1;
    for (let i = 0; i < this.state.batches.length; i++) {
      if (this.state.batches[i].includes(slug)) return i;
    }
    return -1;
  }

  private updateCurrentStage(stage: SequentialAgent): void {
    this.commit({ ...this.state, currentStage: stage });
  }

  private updatePhaseIndex(index: number): void {
    this.commit({ ...this.state, currentPhaseIndex: index });
  }

  private patchStage(
    phaseIndex: number,
    agent: SequentialAgent,
    patch: Partial<AgentStageState>,
  ): void {
    const phases = this.state.phases.slice();
    const phase = phases[phaseIndex];
    if (!phase) return;
    const next: PhaseState = {
      ...phase,
      stages: {
        ...phase.stages,
        [agent]: { ...phase.stages[agent], ...patch },
      },
    };
    phases[phaseIndex] = next;
    this.commit({ ...this.state, phases });
  }

  private patchPhase(phaseIndex: number, patch: Partial<PhaseState>): void {
    const phases = this.state.phases.slice();
    const phase = phases[phaseIndex];
    if (!phase) return;
    phases[phaseIndex] = { ...phase, ...patch };
    this.commit({ ...this.state, phases });
  }

  private commit(next: RunSchedulerState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  /**
   * Serializa el state.json y lo persiste. Actualizamos `lastHeartbeat` cada
   * vez (después de cada cambio significativo de estado — Section 9.2). El
   * heartbeat granular vive en `pulseHeartbeat()` durante invocaciones de
   * agente (Section 9.3).
   */
  private async persistState(): Promise<void> {
    if (!this.state.settings) return;
    const heartbeat = Date.now();
    this.commit({ ...this.state, lastHeartbeat: heartbeat });
    const payload: PersistedRunState = buildPersistedRunState(this.state);
    try {
      await this.invokers.writeState({
        projectPath: this.state.settings.projectPath,
        runId: this.state.settings.runId,
        content: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("loop scheduler: no pude persistir state.json", err);
    }
  }

  /**
   * Section 9.3 — pulso de heartbeat sin re-serializar nada del run. Se
   * dispara mientras un stage está corriendo: el detector de runs
   * interrumpidos usa `lastHeartbeat` para distinguir un proceso vivo de uno
   * muerto. Si el agente tarda 4 minutos en responder pero el timer pulsa
   * cada 5s, el run aparece "vivo" en el banner; si la app muere a mitad
   * de invocación, el último heartbeat queda viejo y el banner aparece al
   * reabrir.
   *
   * Llamamos `persistState()` para que el cambio quede en disco. Es un write
   * por intervalo (default 5s) — barato comparado con el costo de una
   * invocación de LLM.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.persistState();
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Section 9.6 — hidrata el scheduler desde un `PersistedRunState` previamente
   * validado (ver `state-schema.ts::validateRunState`). NO arranca el ciclo;
   * el caller decide si lo retoma con `start()` o lo deja en `paused` para
   * que el usuario lo revise primero.
   *
   * Restricción: el caller debe haber descartado outputs parciales antes de
   * llamar (Section 9.6 descarta los `.md` sin `.diff` companion). El
   * scheduler no inspecciona el FS — sólo restaura el state machine.
   */
  hydrateFromPersisted(persisted: PersistedRunState): void {
    this.stopHeartbeat();
    this.pauseRequested = false;
    this.abortRequested = false;
    this.conflictResolver = null;
    this.commit({
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
}

// ---------------------------------------------------------------------------
// Helpers de parsing y paths
// ---------------------------------------------------------------------------

/** Misma heurística de separador que step1-chat / step2-phases. */
function buildRunPromptPath(projectPath: string, runId: string, name: LoopPromptName): string {
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return [projectPath, ".loop", "runs", runId, "prompts", name].join(sep);
}

/**
 * Parser del veredicto del revisor. El system prompt (`review.md`) le pide al
 * agente devolver `VEREDICTO: aprobado | retry` en la primera línea. Toleramos
 * mayúsculas y guiones — y si no encontramos el header, asumimos `retry` con
 * el texto completo como notas (mejor falso retry que falso approved).
 */
export function parseReviewVerdict(text: string): { approved: boolean; notes: string } {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*VEREDICTO\s*[:=]\s*([\w-]+)/i);
    if (m) {
      const v = m[1].toLowerCase();
      const approved = v === "aprobado" || v === "approved" || v === "ok";
      // Notas: todo lo que viene después del header.
      const idx = text.indexOf(line);
      const notes = text.slice(idx + line.length).trim();
      return { approved, notes: approved ? "" : notes };
    }
  }
  return { approved: false, notes: text.trim() };
}

/**
 * Combina los snapshots de "antes" y "después" en un solo blob legible. Para
 * mantener el archivo .diff útil sin volverlo intratable, guardamos el diff
 * "después" (que ya incluye los cambios del agente respecto a HEAD) y un
 * header con la fecha. El "antes" se conserva como comentario inicial para
 * auditoría — si el usuario ve un agente que sobrescribe trabajo previo, va
 * a aparecer ahí.
 */
export function buildAgentDiff(diffBefore: string, diffAfter: string): string {
  const stamp = new Date().toISOString();
  const parts: string[] = [];
  parts.push(`# Snapshot diff generado por loop scheduler · ${stamp}`);
  parts.push("# (refleja el delta respecto a HEAD después de la corrida del agente)");
  if (diffBefore.trim() && diffBefore.trim() !== diffAfter.trim()) {
    parts.push("#");
    parts.push("# --- estado previo (resumen) ---");
    for (const line of diffBefore.split(/\r?\n/).slice(0, 40)) {
      parts.push(`# ${line}`);
    }
    parts.push("# --- estado post-agente ---");
  }
  parts.push("");
  parts.push(diffAfter.trim() || "(sin cambios respecto a HEAD)");
  parts.push("");
  return parts.join("\n");
}

/**
 * Section 8.4 · detección estructural de conflictos entre fases del mismo
 * batch. Parsea los headers `diff --git a/<path> b/<path>` (formato canónico de
 * git diff). Si dos o más fases tocan el mismo path, lo reportamos.
 *
 * No es a prueba de balas — un agente podría haber escrito un archivo via
 * shell sin que git lo registre (untracked nuevo), pero nuestro snapshot
 * incluye untracked como líneas `# - <path>` aparte (ver `git_diff_sync` en
 * Rust). Las consumimos también.
 *
 * Devuelve una lista ordenada de `{ path, phases[] }` con paths conflictivos.
 */
export interface BatchConflict {
  path: string;
  phases: string[];
}

export function detectBatchConflicts(
  diffs: Array<{ phaseSlug: string; phaseName: string; diff: string }>,
): BatchConflict[] {
  const pathToPhases = new Map<string, Set<string>>();
  const headerRe = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  const untrackedRe = /^# - (.+)$/gm;

  for (const { phaseSlug, diff } of diffs) {
    if (!diff) continue;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    headerRe.lastIndex = 0;
    while ((m = headerRe.exec(diff)) !== null) {
      // a/b refieren al mismo path en cambios in-place; renames usan a!=b.
      // Reportamos ambos lados para que un rename quede flaggeado contra
      // cualquier fase que toque el path original o nuevo.
      const a = m[1].trim();
      const b = m[2].trim();
      if (a) seen.add(a);
      if (b && b !== a) seen.add(b);
    }
    untrackedRe.lastIndex = 0;
    while ((m = untrackedRe.exec(diff)) !== null) {
      const p = m[1].trim();
      if (p) seen.add(p);
    }
    for (const path of seen) {
      let set = pathToPhases.get(path);
      if (!set) {
        set = new Set<string>();
        pathToPhases.set(path, set);
      }
      set.add(phaseSlug);
    }
  }

  const conflicts: BatchConflict[] = [];
  for (const [path, phases] of pathToPhases) {
    if (phases.size >= 2) {
      conflicts.push({ path, phases: Array.from(phases).sort() });
    }
  }
  conflicts.sort((a, b) => a.path.localeCompare(b.path));
  return conflicts;
}

/**
 * Section 8.3 · parseo del veredicto del integrador. El prompt `integration.md`
 * pide cerrar con `INTEGRATION: ok` o `INTEGRATION: blocker`. Toleramos
 * mayúsculas/espacios. Si no aparece el header, asumimos `ok` para no bloquear
 * en falso (el detector estructural va a frenar igual si hay conflicto real).
 */
export function parseIntegrationVerdict(text: string): { status: "ok" | "blocker" } {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*INTEGRATION\s*[:=]\s*([\w-]+)/i);
    if (m) {
      const v = m[1].toLowerCase();
      if (v === "blocker" || v === "block") return { status: "blocker" };
      return { status: "ok" };
    }
  }
  return { status: "ok" };
}

/**
 * Trunca un blob largo para el input del integrador. Mantenemos las primeras
 * y últimas N líneas + un placeholder en el medio. Evita que un diff o un md
 * de implementación grandes consuman todo el context window.
 */
function truncateForIntegrator(text: string, maxLines = 200): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, Math.floor(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  return [
    ...head,
    `... (truncado · ${lines.length - maxLines} línea(s) omitidas) ...`,
    ...tail,
  ].join("\n");
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ---------------------------------------------------------------------------
// Re-exports para Section 7.7 (vista del run)
// ---------------------------------------------------------------------------

export { ALL_AGENT_ROLES, SEQUENTIAL_AGENTS };

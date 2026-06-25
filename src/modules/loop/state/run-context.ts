// Run context model + gate machine for the /loop window chrome.
//
// The /loop window is opened from the main app but lives in a separate
// webview; it reads the same persisted `workspaces.json` via `loadWorkspaces`
// to discover the currently active project. Because the two windows do not
// share an in-memory state machine, we also refresh on focus — when the user
// switches between windows after changing the active project in the main app,
// the loop view re-reads from disk on next focus and updates the gate.
//
// Mirrors the lightweight controller pattern used by
// `src/modules/workspaces/state/workspaces-controller.ts` — single class with
// a listener set + a `getState()` accessor; no external state lib.
//
// Sections 4–7 of the loop-agentic-flow change attach their own state (chat
// history, phases, run scheduler) onto the same controller via the
// `runId`/`projectPath`/`step` fields the chrome already populates here.

import { loadWorkspaces } from "../../../shared/persistence/workspaces-store";
import type { Project, ProjectId, WorkspacesState } from "../../workspaces/state/types";

/**
 * 3 pasos del flow agéntico (proposal.md):
 *   1 — problem intake (chat)
 *   2 — phase decomposition (editor)
 *   3 — setup + run engine
 */
/**
 * Pasos del flujo /loop:
 * 1 — chat de problem intake
 * 2 — descomposición en fases
 * 3 — setup (matriz CLI×modelo + prompts del run)
 * 4 — ejecución del scheduler (vista del run en vivo)
 *
 * El paso 4 se entra desde el paso 3 cuando el usuario pulsa "▶ ejecutar run".
 * Volver a 1/2/3 desde el 4 aborta el scheduler (con confirmación si está vivo).
 */
export type LoopStep = 1 | 2 | 3 | 4;

/**
 * Gate / chrome state. The router renders one of these.
 *
 * - `loading`        : initial read from `workspaces.json` still pending.
 * - `no-project`     : `activeProjectId` is null. The user needs to pick one
 *                      in the main workspace window before /loop is useful.
 * - `invalid-path`   : active project has `pathInvalid=true` (path moved or
 *                      was deleted between sessions; revalidated on startup
 *                      by the main app). Block the loop with an error.
 * - `active`         : healthy active project; the 3-step UI renders inside.
 */
export type LoopRouterState =
  | { status: "loading" }
  | { status: "no-project" }
  | { status: "invalid-path"; project: Project }
  | {
      status: "active";
      project: Project;
      runId: string;
      step: LoopStep;
    };

export type LoopRouterListener = (state: LoopRouterState) => void;

/**
 * Computes the gate state from a freshly-loaded WorkspacesState. Exported so
 * tests (Section 9+) can exercise gate transitions without touching the
 * filesystem.
 */
export function computeGateFromWorkspaces(
  state: WorkspacesState,
  options: { previousRunId?: string | null; previousStep?: LoopStep } = {},
): LoopRouterState {
  const id = state.activeProjectId;
  if (!id) return { status: "no-project" };
  const project = findProjectById(state, id);
  if (!project) return { status: "no-project" };
  if (project.pathInvalid) return { status: "invalid-path", project };
  return {
    status: "active",
    project,
    runId: options.previousRunId ?? generateRunId(),
    step: options.previousStep ?? 1,
  };
}

function findProjectById(state: WorkspacesState, id: ProjectId): Project | null {
  for (const ws of state.workspaces) {
    for (const p of ws.projects) {
      if (p.id === id) return p;
    }
  }
  return null;
}

/**
 * `crypto.randomUUID()` lowercased matches the saneador del backend Rust
 * (`safe_run_id` rechaza espacios / `..` / `/` pero acepta `[A-Za-z0-9_-]`).
 */
function generateRunId(): string {
  return crypto.randomUUID();
}

export class LoopRouter {
  private state: LoopRouterState = { status: "loading" };
  private readonly listeners = new Set<LoopRouterListener>();
  /** Preservado entre refresh: el run-id se mantiene mientras el project no cambie. */
  private currentRunId: string | null = null;
  private currentProjectId: ProjectId | null = null;
  private currentStep: LoopStep = 1;

  getState(): LoopRouterState {
    return this.state;
  }

  on(listener: LoopRouterListener): () => void {
    this.listeners.add(listener);
    // Emit current state immediately so listeners can render without racing
    // the next `refresh()` cycle — same convention as workspaces-controller.
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Re-reads workspaces.json and recomputes the gate. Idempotente. */
  async refresh(): Promise<void> {
    const ws = await loadWorkspaces();
    const projectId = ws.activeProjectId;
    // Cuando cambia el project activo, descartamos el run-id viejo: cada
    // project arranca con su propio run-id fresco. Si el mismo project sigue
    // activo, mantenemos el run-id para no perder el progreso de la sesión.
    const sameProject = projectId !== null && projectId === this.currentProjectId;
    const next = computeGateFromWorkspaces(ws, {
      previousRunId: sameProject ? this.currentRunId : null,
      previousStep: sameProject ? this.currentStep : 1,
    });
    if (next.status === "active") {
      this.currentRunId = next.runId;
      this.currentProjectId = next.project.id;
      this.currentStep = next.step;
    } else {
      this.currentRunId = null;
      this.currentProjectId = null;
      this.currentStep = 1;
    }
    this.commit(next);
  }

  /** Navegación al paso siguiente. Sólo válida en estado `active`. */
  setStep(step: LoopStep): void {
    if (this.state.status !== "active") return;
    this.currentStep = step;
    this.commit({ ...this.state, step });
  }

  /**
   * Abandona el run actual: regenera run-id y vuelve al paso 1. El UI
   * confirma antes de llamar — esta función es la operación pura.
   */
  abandonRun(): void {
    if (this.state.status !== "active") return;
    this.currentRunId = generateRunId();
    this.currentStep = 1;
    this.commit({
      ...this.state,
      runId: this.currentRunId,
      step: 1,
    });
  }

  /**
   * Adopta un run existente: cambia el `runId` actual sin tocar el project.
   * Vuelve al paso 1 — el paso 1 va a hidratar el draft del runId adoptado
   * y, si detecta `01-problem.md` consolidado, mostrar el atajo al paso 2.
   * `step` opcional permite saltar directo al paso 2 o 3 si se llama desde
   * un picker que ya sabe que el run tiene fases/state.
   */
  adoptRunId(runId: string, step: LoopStep = 1): void {
    if (this.state.status !== "active") return;
    if (!runId || runId === this.currentRunId) return;
    this.currentRunId = runId;
    this.currentStep = step;
    this.commit({
      ...this.state,
      runId,
      step,
    });
  }

  private commit(next: LoopRouterState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }
}

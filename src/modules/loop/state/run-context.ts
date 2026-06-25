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
 * 3 steps of the agentic flow (proposal.md):
 *   1 — problem intake (chat)
 *   2 — phase decomposition (editor)
 *   3 — setup + run engine
 */
/**
 * Steps of the /loop flow:
 * 1 — problem intake chat
 * 2 — phase decomposition
 * 3 — setup (CLI×model matrix + run prompts)
 * 4 — scheduler execution (live run view)
 *
 * Step 4 is entered from step 3 when the user clicks "▶ run". Going back to
 * 1/2/3 from 4 aborts the scheduler (with confirmation if it is alive).
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
 * `crypto.randomUUID()` lowercased matches the Rust backend sanitizer
 * (`safe_run_id` rejects spaces / `..` / `/` but accepts `[A-Za-z0-9_-]`).
 */
function generateRunId(): string {
  return crypto.randomUUID();
}

export class LoopRouter {
  private state: LoopRouterState = { status: "loading" };
  private readonly listeners = new Set<LoopRouterListener>();
  /** Preserved across refresh: the run-id is kept while the project does not change. */
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

  /** Re-reads workspaces.json and recomputes the gate. Idempotent. */
  async refresh(): Promise<void> {
    const ws = await loadWorkspaces();
    const projectId = ws.activeProjectId;
    // When the active project changes, we discard the old run-id: each
    // project starts with its own fresh run-id. If the same project remains
    // active, we keep the run-id so we don't lose session progress.
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

  /** Navigate to the next step. Only valid in `active` state. */
  setStep(step: LoopStep): void {
    if (this.state.status !== "active") return;
    this.currentStep = step;
    this.commit({ ...this.state, step });
  }

  /**
   * Abandon the current run: regenerate run-id and go back to step 1. The UI
   * confirms before calling — this function is the pure operation.
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
   * Adopts an existing run: changes the current `runId` without touching the
   * project. Returns to step 1 — step 1 will hydrate the draft of the adopted
   * runId and, if it detects a consolidated `01-problem.md`, show the
   * shortcut to step 2. The optional `step` lets us jump straight to step 2
   * or 3 if called from a picker that already knows the run has phases/state.
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

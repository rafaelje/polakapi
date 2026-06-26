// The /loop window runs in a separate webview from the main app; both read the
// same persisted `workspaces.json`. We refresh on focus because there is no
// shared in-memory state between the two windows.

import { loadWorkspaces } from "../../../shared/persistence/workspaces-store";
import type { Project, ProjectId, WorkspacesState } from "../../workspaces/state/types";

// 1 — problem intake chat
// 2 — phase decomposition
// 3 — setup (CLI×model matrix + run prompts)
// 4 — scheduler execution (live run view)
// Navigating back to 1/2/3 from 4 aborts the scheduler.
export type LoopStep = 1 | 2 | 3 | 4;

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

// Exported so tests can exercise gate transitions without touching the filesystem.
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

// `crypto.randomUUID()` output matches the Rust `safe_run_id` sanitizer
// (rejects spaces / `..` / `/`, accepts `[A-Za-z0-9_-]`).
function generateRunId(): string {
  return crypto.randomUUID();
}

export class LoopRouter {
  private state: LoopRouterState = { status: "loading" };
  private readonly listeners = new Set<LoopRouterListener>();
  // The run-id is preserved across refresh while the project does not change.
  private currentRunId: string | null = null;
  private currentProjectId: ProjectId | null = null;
  private currentStep: LoopStep = 1;

  getState(): LoopRouterState {
    return this.state;
  }

  on(listener: LoopRouterListener): () => void {
    this.listeners.add(listener);
    // Emit current state immediately so listeners can render without racing
    // the next `refresh()` cycle.
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    const ws = await loadWorkspaces();
    const projectId = ws.activeProjectId;
    // Keep the run-id when the same project remains active; discard it when
    // the active project changes so each project starts with a fresh run-id.
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

  setStep(step: LoopStep): void {
    if (this.state.status !== "active") return;
    this.currentStep = step;
    this.commit({ ...this.state, step });
  }

  // Pure operation — the UI must confirm before calling.
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

  // Changes the current `runId` without touching the project. Optional `step`
  // lets the caller jump straight to 2 or 3 if it already knows the run has
  // phases/state.
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

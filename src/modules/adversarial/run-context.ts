// Adversarial-window router. Mirrors the /loop LoopRouter but keeps only 3
// steps: setup → run → report.

import { loadWorkspaces } from "../../shared/persistence/workspaces-store";
import type { Project, ProjectId, WorkspacesState } from "../workspaces/state/types";

export type AdvStep = 1 | 2 | 3;

export type AdvRouterState =
  | { status: "loading" }
  | { status: "no-project" }
  | { status: "invalid-path"; project: Project }
  | {
      status: "active";
      project: Project;
      runId: string;
      step: AdvStep;
    };

export type AdvRouterListener = (state: AdvRouterState) => void;

function findProjectById(state: WorkspacesState, id: ProjectId): Project | null {
  for (const ws of state.workspaces) {
    for (const p of ws.projects) {
      if (p.id === id) return p;
    }
  }
  return null;
}

function generateRunId(): string {
  return crypto.randomUUID();
}

export function computeGateFromWorkspaces(
  state: WorkspacesState,
  options: { previousRunId?: string | null; previousStep?: AdvStep } = {},
): AdvRouterState {
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

export class AdvRouter {
  private state: AdvRouterState = { status: "loading" };
  private readonly listeners = new Set<AdvRouterListener>();
  private currentRunId: string | null = null;
  private currentProjectId: ProjectId | null = null;
  private currentStep: AdvStep = 1;

  getState(): AdvRouterState {
    return this.state;
  }

  on(listener: AdvRouterListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    const ws = await loadWorkspaces();
    const projectId = ws.activeProjectId;
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

  setStep(step: AdvStep): void {
    if (this.state.status !== "active") return;
    this.currentStep = step;
    this.commit({ ...this.state, step });
  }

  freshRun(): void {
    if (this.state.status !== "active") return;
    this.currentRunId = generateRunId();
    this.currentStep = 1;
    this.commit({ ...this.state, runId: this.currentRunId, step: 1 });
  }

  private commit(next: AdvRouterState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }
}

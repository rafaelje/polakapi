import type {
  AgentStageState,
  AgentStageStatus,
  IntegratorStatus,
  RunSchedulerState,
  SequentialAgent,
} from "../core/run-scheduler";
import type { LoopAgentRole } from "../types";

export function describeRunStatus(state: RunSchedulerState): string {
  switch (state.status) {
    case "idle":
      return "prepared — ready to start";
    case "running": {
      const phase = state.phases[state.currentPhaseIndex];
      if (!phase) return "running…";
      const stage = state.currentStage ?? "—";
      return `phase ${phase.id} · ${phase.name} → ${stage}`;
    }
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
    case "error":
      return state.message ? `error: ${state.message}` : "error";
  }
}

export function statusLabel(status: AgentStageStatus): string {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running…";
    case "done":
      return "ok";
    case "warning":
      return "warning";
    case "error":
      return "error";
  }
}

export function roleLabel(role: LoopAgentRole): string {
  switch (role) {
    case "analysis":
      return "analysis";
    case "implementation":
      return "implementation";
    case "review":
      return "reviewer";
    case "knowledge":
      return "knowledge";
    case "integration":
      return "integrator";
  }
}

export function gridCell(text: string, variant: "head" | "body"): HTMLElement {
  const el = document.createElement("div");
  el.className =
    variant === "head" ? "loop-step3-run-cell loop-step3-run-cell-head" : "loop-step3-run-cell";
  el.textContent = text;
  return el;
}

export function formatNumber(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(n >= 10000 ? 1 : 2)}k`;
  }
  return `${n}`;
}

export function agentShortLabel(agent: SequentialAgent): string {
  switch (agent) {
    case "analysis":
      return "anal";
    case "implementation":
      return "impl";
    case "review":
      return "rev";
    case "knowledge":
      return "know";
  }
}

// Each agent is one-shot (no streaming), so running=50 is an indeterminate
// visual; done/warning/error all map to 100 with color signaling the verdict.
export function stageProgressPct(stage: AgentStageState): number {
  switch (stage.status) {
    case "pending":
      return 0;
    case "running":
      return 50;
    case "done":
    case "warning":
    case "error":
      return 100;
  }
}

export function integratorIcon(status: IntegratorStatus): string {
  switch (status) {
    case "pending":
      return "...";
    case "running":
      return "~";
    case "done":
      return "ok";
    case "conflict":
      return "!";
    case "error":
      return "x";
  }
}

export function integratorStatusLabel(status: IntegratorStatus): string {
  switch (status) {
    case "pending":
      return "waiting";
    case "running":
      return "running…";
    case "done":
      return "consolidated";
    case "conflict":
      return "conflict — decide how to proceed";
    case "error":
      return "error";
  }
}

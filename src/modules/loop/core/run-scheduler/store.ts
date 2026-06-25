import type { LoopAgentRole } from "../../types";

import { createInitialState } from "./factories";
import type {
  AgentStageState,
  IntegratorState,
  PhaseState,
  RunSchedulerListener,
  RunSchedulerState,
  SequentialAgent,
} from "./types";

export class StateStore {
  private state: RunSchedulerState = createInitialState();
  private readonly listeners = new Set<RunSchedulerListener>();

  getState(): RunSchedulerState {
    return this.state;
  }

  on(listener: RunSchedulerListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  commit(next: RunSchedulerState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  patchStage(phaseIndex: number, agent: SequentialAgent, patch: Partial<AgentStageState>): void {
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

  /**
   * Functional variant of `patchStage`: derives the patch from the current
   * stage value at commit time. Required for accumulators (tokens/cost)
   * under hybrid mode's `Promise.all` — a plain `patchStage` would capture
   * a stale snapshot and lose concurrent deltas.
   */
  patchStageWith(
    phaseIndex: number,
    agent: SequentialAgent,
    deriver: (current: AgentStageState) => Partial<AgentStageState>,
  ): void {
    const phases = this.state.phases.slice();
    const phase = phases[phaseIndex];
    if (!phase) return;
    const current = phase.stages[agent];
    const next: PhaseState = {
      ...phase,
      stages: {
        ...phase.stages,
        [agent]: { ...current, ...deriver(current) },
      },
    };
    phases[phaseIndex] = next;
    this.commit({ ...this.state, phases });
  }

  patchPhase(phaseIndex: number, patch: Partial<PhaseState>): void {
    const phases = this.state.phases.slice();
    const phase = phases[phaseIndex];
    if (!phase) return;
    phases[phaseIndex] = { ...phase, ...patch };
    this.commit({ ...this.state, phases });
  }

  patchIntegrator(batchIndex: number, patch: Partial<IntegratorState>): void {
    const integrators = this.state.integrators.slice();
    const current = integrators[batchIndex];
    if (!current) return;
    integrators[batchIndex] = { ...current, ...patch };
    this.commit({ ...this.state, integrators });
  }

  /**
   * Reads `this.state` at apply time (NOT from a captured snapshot) so two
   * parallel phases of the same batch both have their deltas survive.
   */
  addToTotals(role: LoopAgentRole, tokensIn: number, tokensOut: number, costUsd: number): void {
    const totals = {
      tokensIn: this.state.totals.tokensIn + tokensIn,
      tokensOut: this.state.totals.tokensOut + tokensOut,
      costUsd: this.state.totals.costUsd + costUsd,
    };
    const prev = this.state.byAgent[role];
    const byAgent = {
      ...this.state.byAgent,
      [role]: {
        tokensIn: prev.tokensIn + tokensIn,
        tokensOut: prev.tokensOut + tokensOut,
        costUsd: prev.costUsd + costUsd,
      },
    };
    this.commit({ ...this.state, totals, byAgent });
  }

  updateCurrentStage(stage: SequentialAgent): void {
    this.commit({ ...this.state, currentStage: stage });
  }

  updatePhaseIndex(index: number): void {
    this.commit({ ...this.state, currentPhaseIndex: index });
  }
}

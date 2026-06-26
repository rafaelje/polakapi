import { stringifyError } from "../../../../shared/errors";
import { buildRunPromptPath, type AgentSlot, type LoopAgentRole } from "../../types";

import { SEQUENTIAL_AGENTS, batchIdFor, createEmptyStage } from "./factories";
import { detectBatchConflicts, parseIntegrationVerdict, truncateForIntegrator } from "./helpers";
import type { HeartbeatController } from "./heartbeat";
import type { StateStore } from "./store";
import type { AgentResult, PhaseState, SchedulerInvokers } from "./types";

export interface IntegratorRunnerDeps {
  store: StateStore;
  invokers: SchedulerInvokers;
  heartbeat: HeartbeatController;
  shouldStop: () => boolean;
  slotFor: (agent: LoopAgentRole) => AgentSlot;
  persistState: () => Promise<void>;
}

export type IntegratorOutcome = "done" | "conflict" | "error";

export class IntegratorRunner {
  constructor(private readonly deps: IntegratorRunnerDeps) {}

  async runIntegrator(batchIndex: number, phaseIndices: number[]): Promise<IntegratorOutcome> {
    const { store, invokers, heartbeat, slotFor, persistState } = this.deps;
    const settings = store.getState().settings;
    if (!settings) return "error";

    // On resume, currentBatchIndex points at the LAST started batch — skip if
    // the integrator already produced a verdict in the prior run.
    if (store.getState().integrators[batchIndex]?.status === "done") return "done";

    store.patchIntegrator(batchIndex, { status: "running", message: undefined });
    store.commit({ ...store.getState(), currentStage: null });

    const phasesOfBatch = phaseIndices
      .map((i) => store.getState().phases[i])
      .filter((p): p is PhaseState => Boolean(p));
    const reads = await Promise.all(
      phasesOfBatch.map(async (phase) => {
        const [knowledge, implDiff, implMd] = await Promise.all([
          invokers
            .readOutput({
              projectPath: settings.projectPath,
              runId: settings.runId,
              phaseSlug: phase.slug,
              agent: "knowledge",
              ext: "md",
            })
            .catch(() => ""),
          invokers
            .readOutput({
              projectPath: settings.projectPath,
              runId: settings.runId,
              phaseSlug: phase.slug,
              agent: "implementation",
              ext: "diff",
            })
            .catch(() => ""),
          invokers
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

    const conflictsByPath = detectBatchConflicts(
      reads.map(({ phase, implDiff }) => ({
        phaseSlug: phase.slug,
        phaseName: phase.name,
        diff: implDiff,
      })),
    );

    const userInput = buildIntegratorPrompt(batchIndex, reads, conflictsByPath);

    const slot = slotFor("integration");
    const systemPromptPath = buildRunPromptPath(
      settings.projectPath,
      settings.runId,
      "integration.md",
    );
    // Per-run prompts are seeded lazily — ensure integration.md exists before
    // the CLI reads it.
    await invokers.ensureRunPrompt({
      projectPath: settings.projectPath,
      runId: settings.runId,
      name: "integration.md",
    });

    let result: AgentResult;
    heartbeat.start();
    try {
      result = await invokers.runAgent({
        cli: slot.cli,
        model: slot.model,
        cwd: settings.projectPath,
        systemPromptPath,
        userInput,
        timeoutSecs: settings.agentTimeoutSecs,
      });
    } catch (err) {
      heartbeat.stop();
      store.patchIntegrator(batchIndex, {
        status: "error",
        message: `error invoking integrator: ${stringifyError(err)}`,
      });
      await persistState();
      return "error";
    }
    heartbeat.stop();
    if (result.error) {
      store.patchIntegrator(batchIndex, {
        status: "error",
        message: result.error,
      });
      await persistState();
      return "error";
    }

    const tokensIn = result.tokensIn ?? 0;
    const tokensOut = result.tokensOut ?? 0;
    const costUsd = result.costUsd ?? 0;
    const integratorState = store.getState().integrators[batchIndex];
    store.patchIntegrator(batchIndex, {
      tokensIn: integratorState.tokensIn + tokensIn,
      tokensOut: integratorState.tokensOut + tokensOut,
      costUsd: integratorState.costUsd + costUsd,
    });
    store.addToTotals("integration", tokensIn, tokensOut, costUsd);

    try {
      await invokers.writeBatchFile({
        projectPath: settings.projectPath,
        runId: settings.runId,
        batchId: batchIdFor(batchIndex),
        file: "knowledge.md",
        content: result.text,
      });
    } catch (err) {
      store.patchIntegrator(batchIndex, {
        status: "error",
        message: `could not persist consolidated knowledge: ${stringifyError(err)}`,
      });
      await persistState();
      return "error";
    }

    // If the structural detector found conflicting paths and the agent
    // did not explicitly waive them with `INTEGRATION: ok`, treat as
    // conflict (conservative side).
    const verdict = parseIntegrationVerdict(result.text);
    const conflictPaths = conflictsByPath.map((c) => c.path);
    const isBlocker =
      verdict.status === "blocker" || (conflictPaths.length > 0 && verdict.status !== "ok");

    if (isBlocker) {
      store.patchIntegrator(batchIndex, {
        status: "conflict",
        conflicts: conflictPaths,
        message:
          verdict.status === "blocker"
            ? "integrator marked BLOCKER — review the consolidated knowledge"
            : "the scheduler detected paths touched by multiple phases — review the knowledge",
      });
      await persistState();
      return "conflict";
    }

    store.patchIntegrator(batchIndex, {
      status: "done",
      conflicts: conflictPaths,
      message: undefined,
    });
    await persistState();
    return "done";
  }

  // Subtracts the prior attempt's tokens from totals/byAgent so a `rerun`
  // decision does not double-count against the budget.
  resetBatchPhases(phaseIndices: number[], batchIndex: number): void {
    const state = this.deps.store.getState();
    const phases = state.phases.slice();
    const integrators = state.integrators.slice();
    const totals = { ...state.totals };
    const byAgent: typeof state.byAgent = {
      analysis: { ...state.byAgent.analysis },
      implementation: { ...state.byAgent.implementation },
      review: { ...state.byAgent.review },
      knowledge: { ...state.byAgent.knowledge },
      integration: { ...state.byAgent.integration },
    };

    const subtract = (role: LoopAgentRole, tIn: number, tOut: number, cost: number): void => {
      totals.tokensIn -= tIn;
      totals.tokensOut -= tOut;
      totals.costUsd -= cost;
      byAgent[role].tokensIn -= tIn;
      byAgent[role].tokensOut -= tOut;
      byAgent[role].costUsd -= cost;
    };

    for (const idx of phaseIndices) {
      const p = phases[idx];
      if (!p) continue;
      for (const agent of SEQUENTIAL_AGENTS) {
        const s = p.stages[agent];
        subtract(agent, s.tokensIn, s.tokensOut, s.costUsd);
      }
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

    const integ = integrators[batchIndex];
    if (integ) {
      subtract("integration", integ.tokensIn, integ.tokensOut, integ.costUsd);
      integrators[batchIndex] = {
        ...integ,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      };
    }

    this.deps.store.commit({
      ...state,
      phases,
      integrators,
      totals,
      byAgent,
    });
  }
}

function buildIntegratorPrompt(
  batchIndex: number,
  reads: Array<{ phase: PhaseState; knowledge: string; implDiff: string; implMd: string }>,
  conflictsByPath: Array<{ path: string; phases: string[] }>,
): string {
  const parts: string[] = [];
  parts.push(`# Integrator of batch ${batchIdFor(batchIndex)}\n`);
  parts.push(
    `There are ${reads.length} phase(s) in this batch. Your job: consolidate the knowledge and detect conflicts.\n`,
  );
  for (const { phase, knowledge, implDiff, implMd } of reads) {
    parts.push(`\n## Phase ${phase.id} · ${phase.name}\n`);
    if (knowledge.trim()) {
      parts.push("### knowledge.md\n");
      parts.push(knowledge.trim());
      parts.push("\n");
    } else {
      parts.push("### knowledge.md\n(no content — the phase produced no knowledge or failed)\n");
    }
    if (implMd.trim()) {
      parts.push("### implementation.md (summary)\n");
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
    parts.push("\n## Structural conflicts detected by the scheduler\n");
    parts.push(
      "The following paths were modified by more than one phase of the batch — review them and mark `BLOCKER` if they break coherence:\n",
    );
    for (const c of conflictsByPath) {
      parts.push(`- \`${c.path}\` — phases: ${c.phases.join(", ")}\n`);
    }
  }
  return parts.join("\n");
}

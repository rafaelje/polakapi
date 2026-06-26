import { stringifyError } from "../../../../shared/errors";
import {
  buildRunPromptPath,
  type AgentSlot,
  type LoopAgentRole,
  type LoopPromptName,
} from "../../types";

import { buildAgentInput, type AgentInputContext } from "./agent-input";
import { SEQUENTIAL_AGENTS } from "./factories";
import { buildAgentDiff, parseReviewVerdict } from "./helpers";
import type { HeartbeatController } from "./heartbeat";
import type { StateStore } from "./store";
import type { AgentResult, SchedulerInvokers, SequentialAgent } from "./types";

export interface PhaseRunnerDeps {
  store: StateStore;
  invokers: SchedulerInvokers;
  heartbeat: HeartbeatController;
  shouldStop: () => boolean;
  slotFor: (agent: LoopAgentRole) => AgentSlot;
  batchIndexForPhase: (slug: string) => number;
  persistState: () => Promise<void>;
}

export class PhaseRunner {
  constructor(private readonly deps: PhaseRunnerDeps) {}

  /**
   * On resume we skip stages that already reached `done`/`warning` —
   * re-running them would burn tokens and could overwrite valid outputs
   * with worse ones. `rewindRunningStages` downgrades `running → pending`
   * before hydration, so everything terminal here is from a real prior run.
   */
  async runPhase(index: number): Promise<void> {
    const { store, shouldStop } = this.deps;
    const settings = store.getState().settings;
    if (!settings) return;
    const phase = store.getState().phases[index];
    if (!phase) return;

    for (const agent of SEQUENTIAL_AGENTS) {
      if (shouldStop()) return;
      const current = store.getState().phases[index]?.stages[agent];
      if (current && (current.status === "done" || current.status === "warning")) {
        continue;
      }
      if (agent === "review") {
        await this.runReviewLoop(index);
      } else if (agent === "implementation") {
        // On resume, replay the prior reviewer's notes so the regenerated
        // output addresses the same complaints.
        const review = store.getState().phases[index]?.stages.review;
        const reviewNotes =
          review && review.retries > 0 && review.message ? review.message : undefined;
        await this.runStage(index, agent, reviewNotes ? { reviewNotes } : undefined);
      } else {
        await this.runStage(index, agent);
      }
      const stage = store.getState().phases[index].stages[agent];
      if (stage.status === "error") {
        store.commit({
          ...store.getState(),
          status: "error",
          message: `phase ${phase.slug} / ${agent}: ${stage.message ?? "unknown error"}`,
        });
        return;
      }
    }

    const stages = store.getState().phases[index].stages;
    const anyWarning =
      stages.analysis.status === "warning" ||
      stages.implementation.status === "warning" ||
      stages.review.status === "warning" ||
      stages.knowledge.status === "warning";
    store.patchPhase(index, {
      status: anyWarning ? "warning" : "done",
    });
    await this.deps.persistState();
  }

  /**
   * Each retry redoes implementation + review until the reviewer approves
   * or we hit the cap. At the cap, we mark the phase as `warning`
   * (reviewerExhausted=true) and continue to knowledge.
   */
  private async runReviewLoop(phaseIndex: number): Promise<void> {
    const { store, shouldStop } = this.deps;
    const settings = store.getState().settings;
    if (!settings) return;
    // Fast-forward past attempts the reviewer already completed in a prior
    // run (rewind decremented the in-flight one by 1).
    let attempt = store.getState().phases[phaseIndex]?.stages.review.retries ?? 0;
    while (attempt < settings.maxRetries) {
      if (shouldStop()) return;
      attempt += 1;
      store.patchStage(phaseIndex, "review", { retries: attempt });
      const verdict = await this.runStage(phaseIndex, "review");
      if (!verdict) {
        return;
      }
      if (verdict.approved) {
        store.patchStage(phaseIndex, "review", { status: "done", message: undefined });
        return;
      }
      // Persist notes before the implementation retry — the resume path
      // reads them to re-feed the regenerated implementation.
      store.patchStage(phaseIndex, "review", { message: verdict.notes });
      if (attempt < settings.maxRetries) {
        if (shouldStop()) return;
        await this.runStage(phaseIndex, "implementation", { reviewNotes: verdict.notes });
        // Bail if the retry implementation failed — running review against
        // a broken or stale output would be pointless.
        const implStage = store.getState().phases[phaseIndex]?.stages.implementation;
        if (implStage?.status === "error") {
          return;
        }
      }
    }
    store.patchPhase(phaseIndex, { reviewerExhausted: true });
    store.patchStage(phaseIndex, "review", {
      status: "warning",
      message: `reviewer did not approve after ${settings.maxRetries} attempt(s) — debt recorded in knowledge`,
    });
  }

  /**
   * For `review`, returns `{ approved, notes }`; for other stages, returns
   * `undefined`. `null` signals a fatal error that has already set the
   * stage's status to `error`.
   */
  private async runStage(
    phaseIndex: number,
    agent: SequentialAgent,
    extras?: { reviewNotes?: string },
  ): Promise<{ approved: boolean; notes: string } | null | undefined> {
    const { store, invokers, persistState, slotFor, batchIndexForPhase } = this.deps;
    const settings = store.getState().settings;
    if (!settings) return null;
    const phase = store.getState().phases[phaseIndex];
    if (!phase) return null;

    store.updateCurrentStage(agent);
    store.patchStage(phaseIndex, agent, { status: "running", message: undefined });

    const diffBefore = await invokers
      .gitDiffSnapshot({ projectPath: settings.projectPath })
      .catch(() => "");

    const inputCtx: AgentInputContext = {
      state: store.getState(),
      settings,
      invokers,
      batchIndexForPhase,
    };
    const userInput = await buildAgentInput(inputCtx, phaseIndex, agent, extras);

    const slot = slotFor(agent);
    const systemPromptPath = buildRunPromptPath(
      settings.projectPath,
      settings.runId,
      `${agent}.md` as LoopPromptName,
    );
    // Per-run prompts are seeded lazily — make sure this agent's file exists
    // on disk before the CLI tries to read it.
    await invokers.ensureRunPrompt({
      projectPath: settings.projectPath,
      runId: settings.runId,
      name: `${agent}.md`,
    });

    const result = await this.invokeAgent({
      cli: slot.cli,
      model: slot.model,
      cwd: settings.projectPath,
      systemPromptPath,
      userInput,
      timeoutSecs: settings.agentTimeoutSecs,
    });

    if (!result.ok) {
      store.patchStage(phaseIndex, agent, {
        status: "error",
        message: result.message,
      });
      await persistState();
      return null;
    }
    const text = result.text;

    const tokensIn = result.tokensIn ?? 0;
    const tokensOut = result.tokensOut ?? 0;
    const costUsd = result.costUsd ?? 0;
    store.patchStageWith(phaseIndex, agent, (s) => ({
      tokensIn: s.tokensIn + tokensIn,
      tokensOut: s.tokensOut + tokensOut,
      costUsd: s.costUsd + costUsd,
    }));
    store.addToTotals(agent, tokensIn, tokensOut, costUsd);

    try {
      await invokers.writeOutput({
        projectPath: settings.projectPath,
        runId: settings.runId,
        phaseSlug: phase.slug,
        agent,
        ext: "md",
        content: text,
      });
    } catch (err) {
      store.patchStage(phaseIndex, agent, {
        status: "error",
        message: `could not persist output: ${stringifyError(err)}`,
      });
      await persistState();
      return null;
    }

    const diffAfter = await invokers
      .gitDiffSnapshot({ projectPath: settings.projectPath })
      .catch(() => "");
    const diffCombined = buildAgentDiff(diffBefore, diffAfter);
    try {
      await invokers.writeOutput({
        projectPath: settings.projectPath,
        runId: settings.runId,
        phaseSlug: phase.slug,
        agent,
        ext: "diff",
        content: diffCombined,
      });
    } catch (err) {
      // The resume-detector treats "md without .diff companion" as a
      // partial output and would discard the valid .md on next launch.
      // Retry once with an empty marker so the invariant ("md + diff =
      // committed") is preserved.
      console.error("loop scheduler: could not persist diff (1st attempt)", err);
      try {
        await invokers.writeOutput({
          projectPath: settings.projectPath,
          runId: settings.runId,
          phaseSlug: phase.slug,
          agent,
          ext: "diff",
          content: "",
        });
      } catch (err2) {
        console.error("loop scheduler: could not persist diff (fallback)", err2);
        store.patchStage(phaseIndex, agent, {
          status: "error",
          message: `output saved but diff snapshot failed: ${stringifyError(err2)}`,
        });
        await persistState();
        return null;
      }
    }

    if (agent !== "review") {
      store.patchStage(phaseIndex, agent, { status: "done" });
      await persistState();
      return undefined;
    }

    // Reviewer: parse and return. `done` is set by `runReviewLoop` so the
    // retry cap can be reflected correctly.
    const parsed = parseReviewVerdict(text);
    await persistState();
    return parsed;
  }

  private async invokeAgent(args: {
    cli: string;
    model: string;
    cwd: string;
    systemPromptPath: string;
    userInput: string;
    timeoutSecs: number;
  }): Promise<
    | {
        ok: true;
        text: string;
        tokensIn?: number | null;
        tokensOut?: number | null;
        costUsd?: number | null;
      }
    | { ok: false; message: string }
  > {
    this.deps.heartbeat.start();
    try {
      const result: AgentResult = await this.deps.invokers.runAgent(args);
      this.deps.heartbeat.stop();
      if (result.error) {
        return { ok: false, message: result.error };
      }
      return {
        ok: true,
        text: result.text,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: result.costUsd,
      };
    } catch (err) {
      this.deps.heartbeat.stop();
      return { ok: false, message: `error invoking agent: ${stringifyError(err)}` };
    }
  }
}

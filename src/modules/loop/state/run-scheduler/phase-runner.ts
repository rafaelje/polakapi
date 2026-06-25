// Runs the per-phase pipeline (analysis → implementation → review →
// knowledge) against a `StateStore`. Owns no state of its own — every
// invocation goes through the store, the heartbeat controller, and the
// persistence queue passed at construction. The scheduler tells it when
// to stop via the `shouldStop` callback.

import { stringifyError } from "../../../../shared/errors";
import {
  buildRunPromptPath,
  type AgentSlot,
  type LoopAgentRole,
  type LoopPromptName,
} from "../types";

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
  /** Slot lookup for the given agent role (from the run matrix). */
  slotFor: (agent: LoopAgentRole) => AgentSlot;
  /** Returns the batch index a phase belongs to (-1 in sequential mode). */
  batchIndexForPhase: (slug: string) => number;
  /** Schedules a `state.json` persistence write through the shared queue. */
  persistState: () => Promise<void>;
}

export class PhaseRunner {
  constructor(private readonly deps: PhaseRunnerDeps) {}

  /**
   * Runs the 4 stages for a phase in order. On resume we skip stages that
   * already reached a terminal state (`done` / `warning`) — re-running
   * them would burn tokens and could overwrite valid outputs with worse
   * ones. `rewindRunningStages` downgrades `running → pending`, so
   * everything `done`/`warning` here is a real completed substage from a
   * prior attempt.
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
      } else {
        await this.runStage(index, agent);
      }
      // If the stage ended in fatal error, stop the cycle and leave the
      // run in `error`. The user can inspect and eventually resume.
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

    // Aggregate the global phase status. If any stage ended in warning,
    // the phase is warning.
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
   * Reviewer loop with retry cap. Each retry redoes implementation +
   * review until the reviewer approves or we hit the cap. At the cap, we
   * mark the phase as `warning` (reviewerExhausted=true) and move on to
   * knowledge — design decision #4.
   */
  private async runReviewLoop(phaseIndex: number): Promise<void> {
    const { store, shouldStop } = this.deps;
    const settings = store.getState().settings;
    if (!settings) return;
    let attempt = 0;
    while (attempt < settings.maxRetries) {
      if (shouldStop()) return;
      attempt += 1;
      store.patchStage(phaseIndex, "review", { retries: attempt });
      const verdict = await this.runStage(phaseIndex, "review");
      // For `review`, runStage returns { approved, notes } or null (error).
      // The `undefined` only applies to non-review stages — defensive.
      if (!verdict) {
        // Fatal reviewer error (we did not get to parse the verdict).
        return;
      }
      if (verdict.approved) {
        store.patchStage(phaseIndex, "review", { status: "done" });
        return;
      }
      // Verdict = retry. If attempts remain, re-run implementation with
      // the reviewer notes as additional input.
      if (attempt < settings.maxRetries) {
        if (shouldStop()) return;
        await this.runStage(phaseIndex, "implementation", { reviewNotes: verdict.notes });
        // If the retry implementation failed (CLI error / timeout), bail
        // out of the loop — running review against a broken or stale
        // output would be pointless. `runPhase` will see the `error`
        // status and surface it as a fatal error for the phase.
        const implStage = store.getState().phases[phaseIndex]?.stages.implementation;
        if (implStage?.status === "error") {
          return;
        }
      }
    }
    // Cap reached without approval.
    store.patchPhase(phaseIndex, { reviewerExhausted: true });
    store.patchStage(phaseIndex, "review", {
      status: "warning",
      message: "reviewer did not approve after 3 attempts — debt recorded in knowledge",
    });
  }

  /**
   * Executes an individual pipeline stage. Encapsulates:
   *   1. diff snapshot before
   *   2. build the agent's user input
   *   3. invoke `run_loop_agent` (with the heartbeat pulsing)
   *   4. accumulate tokens/cost atomically
   *   5. persist `<phase>/<agent>.md`
   *   6. persist `<phase>/<agent>.diff` (with one retry on failure)
   *   7. mark `done` (non-reviewer) or return the parsed verdict
   *
   * Returns for `review` an object `{ approved, notes }` extracted from
   * the CLI verdict; for the others it returns undefined. `null` is
   * reserved for fatal errors that already set the stage's status to
   * `error`.
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

    // 1. Diff snapshot before the agent. If it fails, not fatal — we
    //    store an empty string and move on.
    const diffBefore = await invokers
      .gitDiffSnapshot({ projectPath: settings.projectPath })
      .catch(() => "");

    // 2. Build the agent's user input. System prompt goes by path;
    //    specific inputs (logic.md, knowledge from the previous phase,
    //    etc.) travel in the body.
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

    // 3. Invoke with heartbeat pulsing.
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

    // 4. Accumulate tokens/cost via functional patches — see store.ts.
    const tokensIn = result.tokensIn ?? 0;
    const tokensOut = result.tokensOut ?? 0;
    const costUsd = result.costUsd ?? 0;
    store.patchStageWith(phaseIndex, agent, (s) => ({
      tokensIn: s.tokensIn + tokensIn,
      tokensOut: s.tokensOut + tokensOut,
      costUsd: s.costUsd + costUsd,
    }));
    store.addToTotals(agent, tokensIn, tokensOut, costUsd);

    // 5. Persist md output.
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

    // 6. Snapshot the diff afterwards.
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
          message: `output saved but diff snapshot failed: ${stringifyError(err2)}`,
        });
      }
    }

    // 7. If not reviewer, mark done and persist state.
    if (agent !== "review") {
      store.patchStage(phaseIndex, agent, { status: "done" });
      await persistState();
      return undefined;
    }

    // Reviewer: parse the verdict and return it to the loop. `done` is
    // set by `runReviewLoop` to reflect the cap correctly.
    const parsed = parseReviewVerdict(text);
    await persistState();
    return parsed;
  }

  /**
   * Wraps the `runAgent` invocation with the heartbeat ref-count and a
   * uniform error envelope. The phase runner uses this; the integrator
   * runner re-implements the same shape (with its own state field) to
   * keep their persistence semantics independent.
   */
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

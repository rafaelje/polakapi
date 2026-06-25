// Builds the user-input blob fed to each agent invocation.
//
// Pure function of `(state, settings, invokers, phaseIndex, agent, extras)`
// — it reads files on disk via the invoker interface but does not mutate
// scheduler state. Extracted from `RunScheduler` because the body is ~175
// lines, every input it needs is already explicit, and isolating it makes
// the test surface for the agent prompts much smaller.

import { batchIdFor } from "./factories";
import type { RunSchedulerState, RunSettings, SchedulerInvokers, SequentialAgent } from "./types";

export interface AgentInputContext {
  state: RunSchedulerState;
  settings: RunSettings;
  invokers: SchedulerInvokers;
  /** Same impl as `RunScheduler.batchIndexForPhase`. */
  batchIndexForPhase: (slug: string) => number;
}

/**
 * Builds the user input passed to the agent. Each agent receives different
 * files as context. Reads are tolerant to "does not exist yet" (empty
 * read) — design decision #1 makes the contract file-based on disk, not
 * temporal-order based.
 */
export async function buildAgentInput(
  ctx: AgentInputContext,
  phaseIndex: number,
  agent: SequentialAgent,
  extras?: { reviewNotes?: string },
): Promise<string> {
  const { state, settings, invokers, batchIndexForPhase } = ctx;
  const phase = state.phases[phaseIndex];
  if (!phase) return "";

  // In sequential mode, "previous phase" is phaseIndex - 1 (flattened
  // topological order). In hybrid mode the same-batch phases run in
  // parallel: we cannot read knowledge between phases of the same batch
  // because it probably does not exist yet; instead we inject the
  // consolidated knowledge of the previous batch (Section 8.6) below.
  const prevPhase =
    state.mode === "sequential" && phaseIndex > 0 ? state.phases[phaseIndex - 1] : null;

  // Common inputs: phase logic.md + previous-phase knowledge.md
  // (sequential) or previous-batch knowledge (hybrid).
  const batchIndex = batchIndexForPhase(phase.slug);
  const prevBatchKnowledgePromise =
    state.mode === "hybrid" && batchIndex > 0
      ? invokers
          .readBatchFile({
            projectPath: settings.projectPath,
            runId: settings.runId,
            batchId: batchIdFor(batchIndex - 1),
            file: "knowledge.md",
          })
          .catch(() => "")
      : Promise.resolve("");

  const [logic, prevKnowledge, prevBatchKnowledge] = await Promise.all([
    invokers
      .readPhaseFile({
        projectPath: settings.projectPath,
        runId: settings.runId,
        phaseSlug: phase.slug,
        file: "logic.md",
      })
      .catch(() => ""),
    prevPhase
      ? invokers
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
  parts.push(`# Phase ${phase.id} · ${phase.name}\n`);
  parts.push("## logic.md\n");
  parts.push(logic.trim() || "(empty)");
  parts.push("\n");

  if (prevKnowledge.trim()) {
    parts.push(`## Knowledge from the previous phase (${prevPhase?.name ?? ""})\n`);
    parts.push(prevKnowledge.trim());
    parts.push("\n");
  }

  if (prevBatchKnowledge.trim()) {
    parts.push(`## Consolidated knowledge from the previous batch (batch-${batchIndex - 1})\n`);
    parts.push(prevBatchKnowledge.trim());
    parts.push("\n");
  }

  if (agent === "implementation" || agent === "review" || agent === "knowledge") {
    const analysis = await invokers
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
    const impl = await invokers
      .readOutput({
        projectPath: settings.projectPath,
        runId: settings.runId,
        phaseSlug: phase.slug,
        agent: "implementation",
        ext: "md",
      })
      .catch(() => "");
    const implDiff = await invokers
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
    const review = await invokers
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
      parts.push("## TECHNICAL DEBT\n");
      parts.push(
        "The reviewer did not approve after 3 attempts. This phase carries a propagated `warning`.\n" +
          "Explicitly record in your `knowledge.md` output what remained unresolved and what the user or a later phase would need to cover manually.\n",
      );
    }
  }

  if (extras?.reviewNotes && agent === "implementation") {
    parts.push("## Reviewer notes from the previous attempt\n");
    parts.push(extras.reviewNotes.trim());
    parts.push("\n\nAddress these notes before returning the output.\n");
  }

  return parts.join("\n");
}

import { describe, it, expect } from "vitest";

import type { Phase } from "../step2-phases";
import {
  RunScheduler,
  buildAgentDiff,
  detectBatchConflicts,
  parseReviewVerdict,
  parseIntegrationVerdict,
  type RunSettings,
  type SchedulerInvokers,
} from "./run-scheduler";
import { createDefaultMatrix, type LoopAgentRole } from "./types";

const baseSettings = (): RunSettings => ({
  projectPath: "/tmp/proj",
  runId: "run-1",
  matrix: createDefaultMatrix(),
  promptOverrides: {},
  maxRetries: 3,
  agentTimeoutSecs: 60,
});

const fakeInvokers = (
  overrides: Partial<SchedulerInvokers> = {},
): {
  invokers: SchedulerInvokers;
  calls: { agent: string }[];
} => {
  const calls: { agent: string }[] = [];
  const invokers: SchedulerInvokers = {
    runAgent: (args) => {
      // The system prompt path encodes the agent name in the filename.
      const agentName = args.systemPromptPath?.match(/([a-z]+)\.md$/)?.[1] ?? "?";
      calls.push({ agent: agentName });
      // Reviewer must produce a parseable verdict so the loop doesn't stall.
      const text = agentName === "review" ? "VERDICT: ok" : "ok";
      return Promise.resolve({ text, tokensIn: 10, tokensOut: 5, costUsd: 0.01 });
    },
    readOutput: () => Promise.resolve(""),
    writeOutput: () => Promise.resolve(),
    writeState: () => Promise.resolve(),
    gitDiffSnapshot: () => Promise.resolve(""),
    readPhaseFile: () => Promise.resolve(""),
    readBatchFile: () => Promise.resolve(""),
    writeBatchFile: () => Promise.resolve(),
    ...overrides,
  };
  // Re-apply any overrides that took precedence over runAgent so we still
  // record calls correctly when callers replace it.
  if (overrides.runAgent) invokers.runAgent = overrides.runAgent;
  return { invokers, calls };
};

const phase = (id: string, deps: string[] = []): Phase => ({
  id,
  name: id,
  summary: "",
  dependsOn: deps,
  hasVisual: false,
});

describe("RunScheduler — skip-done on resume (sequential)", () => {
  it("does not re-invoke agents for stages already marked done", async () => {
    const { invokers, calls } = fakeInvokers();
    const scheduler = new RunScheduler(invokers);
    scheduler.initialize([phase("a")], baseSettings(), "sequential");

    // Simulate a resumed phase whose analysis + implementation were already
    // done by a previous attempt — only `review` and `knowledge` should run.
    const state = scheduler.getState();
    state.phases[0].stages.analysis.status = "done";
    state.phases[0].stages.implementation.status = "done";

    await scheduler.start();

    const agents = calls.map((c) => c.agent).sort();
    expect(agents).toEqual(["knowledge", "review"]);
  });

  it("skips warning stages too — re-running them would burn tokens for no gain", async () => {
    const { invokers, calls } = fakeInvokers();
    const scheduler = new RunScheduler(invokers);
    scheduler.initialize([phase("a")], baseSettings(), "sequential");

    const state = scheduler.getState();
    state.phases[0].stages.analysis.status = "warning";

    await scheduler.start();

    expect(calls.map((c) => c.agent)).not.toContain("analysis");
  });
});

describe("RunScheduler — atomic totals under concurrent batch (hybrid)", () => {
  it("does not drop tokens when two phases of the same batch invoke in parallel", async () => {
    // Two independent phases run in the same batch — Promise.all kicks both
    // off concurrently. Each agent invocation reports +10/+5/+0.01. The two
    // phases run 4 stages each => 8 invocations. Total must be 80/40/0.08
    // exactly (no race-induced loss).
    let resolveGate: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    let inflight = 0;
    let peakInflight = 0;
    const { invokers } = fakeInvokers({
      runAgent: async (args) => {
        inflight += 1;
        peakInflight = Math.max(peakInflight, inflight);
        // Hold the first parallel pair so they have to commit concurrently —
        // a non-atomic accumulator would lose one of them.
        if (inflight === 2) resolveGate!();
        await gate;
        inflight -= 1;
        const agentName = args.systemPromptPath?.match(/([a-z]+)\.md$/)?.[1] ?? "?";
        const text = agentName === "review" ? "VERDICT: ok" : "ok";
        return { text, tokensIn: 10, tokensOut: 5, costUsd: 0.01 };
      },
    });
    const scheduler = new RunScheduler(invokers);
    scheduler.initialize([phase("a"), phase("b")], baseSettings(), "hybrid");

    await scheduler.start();

    const totals = scheduler.getState().totals;
    // 4 stages × 2 phases + 1 integrator = 9 invocations × +10 = 90; same
    // shape for out/cost.
    expect(totals.tokensIn).toBe(90);
    expect(totals.tokensOut).toBe(45);
    expect(totals.costUsd).toBeCloseTo(0.09, 5);
    // Sanity: the gate forced at least one window with 2 in-flight agents.
    expect(peakInflight).toBeGreaterThanOrEqual(2);
  });

  it("per-agent rollup also survives parallel commits", async () => {
    const { invokers } = fakeInvokers();
    const scheduler = new RunScheduler(invokers);
    scheduler.initialize([phase("a"), phase("b")], baseSettings(), "hybrid");
    await scheduler.start();

    const by = scheduler.getState().byAgent;
    // analysis runs once per phase => 2 × 10 in tokens.
    const roles: LoopAgentRole[] = ["analysis", "implementation", "review", "knowledge"];
    for (const r of roles) {
      expect(by[r].tokensIn).toBe(20);
    }
    // One integrator runs after the (single) batch.
    expect(by.integration.tokensIn).toBe(10);
  });
});

describe("pure helpers", () => {
  it("parseReviewVerdict accepts ok/approved synonyms", () => {
    expect(parseReviewVerdict("VERDICT: ok").approved).toBe(true);
    expect(parseReviewVerdict("verdict: approved").approved).toBe(true);
    expect(parseReviewVerdict("VERDICT: retry\nneeds X").approved).toBe(false);
    expect(parseReviewVerdict("no header at all").approved).toBe(false);
  });

  it("parseIntegrationVerdict surfaces blocker", () => {
    expect(parseIntegrationVerdict("INTEGRATION: ok").status).toBe("ok");
    expect(parseIntegrationVerdict("INTEGRATION: blocker").status).toBe("blocker");
    expect(parseIntegrationVerdict("INTEGRATION: block").status).toBe("blocker");
  });

  it("detectBatchConflicts flags paths touched by 2+ phases", () => {
    const diffs = [
      {
        phaseSlug: "a",
        phaseName: "a",
        diff: "diff --git a/src/x.ts b/src/x.ts\n@@\n",
      },
      {
        phaseSlug: "b",
        phaseName: "b",
        diff: "diff --git a/src/x.ts b/src/x.ts\n@@\ndiff --git a/src/y.ts b/src/y.ts\n",
      },
    ];
    const conflicts = detectBatchConflicts(diffs);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].path).toBe("src/x.ts");
    expect(conflicts[0].phases.sort()).toEqual(["a", "b"]);
  });

  it("detectBatchConflicts ignores files touched by a single phase", () => {
    const diffs = [
      {
        phaseSlug: "a",
        phaseName: "a",
        diff: "diff --git a/only.ts b/only.ts\n",
      },
    ];
    expect(detectBatchConflicts(diffs)).toEqual([]);
  });

  it("buildAgentDiff prefers the after-snapshot but annotates pre-existing state", () => {
    const before = "diff --git a/old.ts b/old.ts\n";
    const after = "diff --git a/old.ts b/old.ts\ndiff --git a/new.ts b/new.ts\n";
    const combined = buildAgentDiff(before, after);
    expect(combined).toContain("new.ts");
  });
});

import { describe, it, expect } from "vitest";

import type { Phase } from "../../step2-phases";
import {
  RunScheduler,
  buildAgentDiff,
  detectBatchConflicts,
  parseReviewVerdict,
  parseIntegrationVerdict,
  type RunSettings,
  type SchedulerInvokers,
} from ".";
import { createDefaultMatrix, type LoopAgentRole } from "../../types";

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
    ensureRunPrompt: () => Promise.resolve(),
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

describe("RunScheduler — within-batch hybrid execution", () => {
  it("runs phases of the same batch sequentially (not in parallel)", async () => {
    // Phases share a working tree, so each agent's `git diff HEAD` snapshot
    // would otherwise capture sibling phases' changes — corrupting the
    // per-phase `.diff` and poisoning detectBatchConflicts. The scheduler
    // serializes within a batch to keep the diff attribution honest.
    let inflight = 0;
    let peakInflight = 0;
    const { invokers } = fakeInvokers({
      runAgent: async (args) => {
        inflight += 1;
        peakInflight = Math.max(peakInflight, inflight);
        // Yield to other microtasks so any concurrent invocation would
        // become observable in `peakInflight`.
        await Promise.resolve();
        await Promise.resolve();
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
    // 4 stages × 2 phases + 1 integrator = 9 invocations × +10 = 90.
    expect(totals.tokensIn).toBe(90);
    expect(totals.tokensOut).toBe(45);
    expect(totals.costUsd).toBeCloseTo(0.09, 5);
    // No two agent invocations may overlap within the batch.
    expect(peakInflight).toBe(1);
  });

  it("per-agent rollup tallies every invocation", async () => {
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

// Helper: track every runAgent invocation. Returns invokers + the call log
// + a `prepare(fn)` setter so each test can customize the response shape
// without losing the per-invocation tally.
const trackingInvokers = (
  respond: (
    agent: string,
    args: Parameters<SchedulerInvokers["runAgent"]>[0],
  ) => Promise<Awaited<ReturnType<SchedulerInvokers["runAgent"]>>>,
): { invokers: SchedulerInvokers; calls: { agent: string }[] } => {
  const calls: { agent: string }[] = [];
  const invokers: SchedulerInvokers = {
    runAgent: async (args) => {
      const agent = args.systemPromptPath?.match(/([a-z]+)\.md$/)?.[1] ?? "?";
      calls.push({ agent });
      return respond(agent, args);
    },
    readOutput: () => Promise.resolve(""),
    writeOutput: () => Promise.resolve(),
    writeState: () => Promise.resolve(),
    gitDiffSnapshot: () => Promise.resolve(""),
    readPhaseFile: () => Promise.resolve(""),
    readBatchFile: () => Promise.resolve(""),
    writeBatchFile: () => Promise.resolve(),
    ensureRunPrompt: () => Promise.resolve(),
  };
  return { invokers, calls };
};

describe("RunScheduler — reviewer cap (sequential)", () => {
  it("marks the review stage `warning` and continues to knowledge after maxRetries", async () => {
    // The reviewer never approves: every call returns `VERDICT: retry`. The
    // loop is `attempt < maxRetries`: each iteration runs `review`, then if
    // not the last iteration runs `implementation` again with the notes. So
    // for maxRetries=3 → 3 reviews + 2 retry-impls + 1 initial impl + 1
    // analysis + 1 knowledge.
    const settings = { ...baseSettings(), maxRetries: 3 };
    const { invokers, calls } = trackingInvokers((agent) =>
      Promise.resolve({
        text: agent === "review" ? "VERDICT: retry\nneeds work" : "ok",
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      }),
    );
    const scheduler = new RunScheduler(invokers);
    scheduler.initialize([phase("a")], settings, "sequential");

    await scheduler.start();

    const tally = calls.reduce<Record<string, number>>((acc, c) => {
      acc[c.agent] = (acc[c.agent] ?? 0) + 1;
      return acc;
    }, {});
    expect(tally.analysis).toBe(1);
    expect(tally.implementation).toBe(3); // 1 initial + 2 retry-impls
    expect(tally.review).toBe(3); // cap
    expect(tally.knowledge).toBe(1); // still runs despite the cap

    const phaseState = scheduler.getState().phases[0];
    expect(phaseState.reviewerExhausted).toBe(true);
    expect(phaseState.stages.review.status).toBe("warning");
    expect(phaseState.status).toBe("warning");
    expect(scheduler.getState().status).toBe("completed");
  });
});

describe("RunScheduler — fatal errors stop the cycle", () => {
  it("returns status=error and does not start the next phase", async () => {
    const { invokers } = trackingInvokers((agent) => {
      if (agent === "implementation") {
        return Promise.resolve({
          text: "",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          error: "model down",
        });
      }
      const text = agent === "review" ? "VERDICT: ok" : "ok";
      return Promise.resolve({ text, tokensIn: 0, tokensOut: 0, costUsd: 0 });
    });
    const scheduler = new RunScheduler(invokers);
    scheduler.initialize([phase("a"), phase("b")], baseSettings(), "sequential");
    await scheduler.start();

    const state = scheduler.getState();
    expect(state.status).toBe("error");
    expect(state.phases[0].stages.implementation.status).toBe("error");
    // The second phase must NOT have started.
    expect(state.phases[1].stages.analysis.status).toBe("pending");
  });
});

describe("RunScheduler — abort sets status=aborted", () => {
  it("flips to aborted when abort() runs mid-cycle", async () => {
    let firstStarted: (() => void) | null = null;
    const started = new Promise<void>((r) => {
      firstStarted = r;
    });
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { invokers } = trackingInvokers(async (agent) => {
      if (firstStarted) {
        firstStarted();
        firstStarted = null;
      }
      await gate;
      const text = agent === "review" ? "VERDICT: ok" : "ok";
      return { text, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    });
    const scheduler = new RunScheduler(invokers);
    scheduler.initialize([phase("a"), phase("b")], baseSettings(), "sequential");
    const run = scheduler.start();
    await started;
    scheduler.abort();
    release!();
    await run;

    expect(scheduler.getState().status).toBe("aborted");
  });
});

describe("RunScheduler — hybrid integrator", () => {
  it("invokes the integrator agent once after each batch", async () => {
    const { invokers, calls } = trackingInvokers((agent) =>
      Promise.resolve({
        text:
          agent === "review" ? "VERDICT: ok" : agent === "integration" ? "INTEGRATION: ok" : "ok",
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      }),
    );
    const scheduler = new RunScheduler(invokers);
    // Two phases, one depends on the other → two batches → two integrator runs.
    scheduler.initialize([phase("a"), phase("b", ["a"])], baseSettings(), "hybrid");
    await scheduler.start();

    const integratorCalls = calls.filter((c) => c.agent === "integration");
    expect(integratorCalls).toHaveLength(2);
    expect(scheduler.getState().integrators.every((i) => i.status === "done")).toBe(true);
    expect(scheduler.getState().status).toBe("completed");
  });
});

describe("RunScheduler — terminal-state guard", () => {
  it("start() is a no-op from completed/aborted/error", async () => {
    // Re-entering start() from a terminal state would re-run the last batch's
    // integrator (no skip-done upstream): a fresh attempt must call
    // initialize() first.
    const { invokers, calls } = trackingInvokers((agent) =>
      Promise.resolve({
        text: agent === "review" ? "VERDICT: ok" : "ok",
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      }),
    );
    const scheduler = new RunScheduler(invokers);
    scheduler.initialize([phase("a")], baseSettings(), "sequential");
    await scheduler.start();
    const callsAfterFirst = calls.length;
    expect(scheduler.getState().status).toBe("completed");

    await scheduler.start();
    expect(calls.length).toBe(callsAfterFirst);
  });
});

describe("RunScheduler — integrator skip-done on resume", () => {
  it("does not re-run an integrator already marked done", async () => {
    // Simulate a crash that landed between integrator.status='done' and
    // currentBatchIndex += 1. On resume the hybrid cycle re-enters the same
    // batch index; the integrator must NOT re-run.
    const { invokers, calls } = trackingInvokers((agent) =>
      Promise.resolve({
        text:
          agent === "review" ? "VERDICT: ok" : agent === "integration" ? "INTEGRATION: ok" : "ok",
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      }),
    );
    const scheduler = new RunScheduler(invokers);
    scheduler.initialize([phase("a")], baseSettings(), "hybrid");
    const state = scheduler.getState();
    // Pretend every stage already completed in a prior run and the integrator
    // also already produced a verdict, but currentBatchIndex never advanced.
    for (const stage of ["analysis", "implementation", "review", "knowledge"] as const) {
      state.phases[0].stages[stage].status = "done";
    }
    state.phases[0].status = "done";
    state.integrators[0].status = "done";

    await scheduler.start();

    expect(calls.filter((c) => c.agent === "integration")).toHaveLength(0);
    expect(scheduler.getState().status).toBe("completed");
  });
});

describe("RunScheduler — resetBatchPhases token accounting", () => {
  it("subtracts spent tokens from totals/byAgent on rerun", async () => {
    // 1-phase batch where the integrator returns BLOCKER on the first run.
    // We resolve the conflict with 'rerun' on the SECOND run; the rerun's
    // tokens must NOT double-count against totals.
    let integratorCallCount = 0;
    const { invokers } = trackingInvokers((agent) => {
      if (agent === "integration") {
        integratorCallCount += 1;
        return Promise.resolve({
          // First call returns BLOCKER → conflict path; second returns ok.
          text: integratorCallCount === 1 ? "INTEGRATION: blocker" : "INTEGRATION: ok",
          tokensIn: 10,
          tokensOut: 5,
          costUsd: 0.01,
        });
      }
      return Promise.resolve({
        text: agent === "review" ? "VERDICT: ok" : "ok",
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0.01,
      });
    });
    const scheduler = new RunScheduler(invokers);
    scheduler.initialize([phase("a")], baseSettings(), "hybrid");

    const run = scheduler.start();
    // Wait for the conflict to pause the scheduler.
    await new Promise<void>((resolve) => {
      const off = scheduler.on((s) => {
        if (s.status === "paused") {
          off();
          resolve();
        }
      });
    });
    scheduler.resolveConflict("rerun");
    await run;

    const totals = scheduler.getState().totals;
    // After the rerun, only the SECOND attempt's tokens should be accounted
    // for: 4 phase stages + 1 integrator = 5 invocations × 10/5/0.01.
    expect(totals.tokensIn).toBe(50);
    expect(totals.tokensOut).toBe(25);
    expect(totals.costUsd).toBeCloseTo(0.05, 5);
    // The integrator's per-stage counters also reset between attempts.
    const integ = scheduler.getState().integrators[0];
    expect(integ.tokensIn).toBe(10);
    expect(integ.status).toBe("done");
  });
});

describe("pure helpers", () => {
  it("parseReviewVerdict accepts ok/approved synonyms", () => {
    expect(parseReviewVerdict("VERDICT: ok").approved).toBe(true);
    expect(parseReviewVerdict("verdict: approved").approved).toBe(true);
    expect(parseReviewVerdict("VERDICT: retry\nneeds X").approved).toBe(false);
    expect(parseReviewVerdict("no header at all").approved).toBe(false);
  });

  it("parseReviewVerdict picks the actual verdict line, not an earlier echo", () => {
    // The body quotes the rubric ("emit `VERDICT: retry`…") BEFORE the real
    // verdict line. A naive `indexOf(line)` would slice notes from the echo
    // and include the verdict line itself inside the notes.
    const text = [
      "Rubric note: the reviewer may emit `VERDICT: retry` for any issue.",
      "",
      "VERDICT: retry",
      "real reason A",
      "real reason B",
    ].join("\n");
    const v = parseReviewVerdict(text);
    expect(v.approved).toBe(false);
    expect(v.notes.startsWith("real reason A")).toBe(true);
    expect(v.notes).not.toContain("VERDICT: retry");
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

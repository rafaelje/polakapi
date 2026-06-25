// Section 10.1 — bridge between the RunScheduler and `shared/ui/toast.ts`.
//
// The module subscribes to the scheduler and emits toasts for key run events,
// so the user gets immediate feedback without having to watch the timeline
// closely:
//
//   - run completed       → "success" toast
//   - phase with warning  → "warning" toast (only once per phase)
//   - conflict detected   → "warning" toast with the list of paths
//
// The notifier keeps a small internal state machine that compares the previous
// snapshot against the current one to avoid firing duplicate toasts (the
// scheduler emits many events per agent — without this, "phase X with warning"
// would fire 4-5 times as the knowledge agent runs and persists).
//
// Pattern: follows the "imperative listener" of the rest of the /loop module —
// `attachRunNotifier(scheduler)` returns an unsubscribe.

import { showToast } from "../../shared/ui/toast";
import type { RunScheduler, RunSchedulerState } from "./state/run-scheduler";

export interface NotifierHandle {
  dispose(): void;
}

interface NotifierMemo {
  status: RunSchedulerState["status"] | null;
  /** Slugs of phases that already triggered a warning toast. */
  warnedPhases: Set<string>;
  /** batchId of the integrators that already triggered a conflict toast. */
  conflictedBatches: Set<string>;
}

function createMemo(): NotifierMemo {
  return {
    status: null,
    warnedPhases: new Set(),
    conflictedBatches: new Set(),
  };
}

function notify(state: RunSchedulerState, memo: NotifierMemo): void {
  // 1. Transition to `completed`: run finished OK.
  if (state.status === "completed" && memo.status !== "completed") {
    const phaseCount = state.phases.length;
    const warningCount = state.phases.filter((p) => p.reviewerExhausted).length;
    if (warningCount === 0) {
      showToast(`run completed · ${phaseCount} phase${phaseCount === 1 ? "" : "s"}`, "success");
    } else {
      showToast(
        `run completed with ${warningCount} warning${warningCount === 1 ? "" : "s"}`,
        "warning",
      );
    }
  }

  // 2. Phases that hit the reviewer cap — only once per phase.
  for (const phase of state.phases) {
    if (phase.reviewerExhausted && !memo.warnedPhases.has(phase.slug)) {
      memo.warnedPhases.add(phase.slug);
      showToast(`phase "${phase.name}" hit the reviewer cap`, "warning");
    }
  }

  // 3. Integrators in conflict — one per batch.
  for (const integrator of state.integrators) {
    if (integrator.status === "conflict" && !memo.conflictedBatches.has(integrator.batchId)) {
      memo.conflictedBatches.add(integrator.batchId);
      const n = integrator.conflicts.length;
      const summary =
        n === 0
          ? "no paths reported — check the integrator card"
          : `${n} path${n === 1 ? "" : "s"} in conflict`;
      showToast(`conflict detected in ${integrator.batchId} · ${summary}`, "warning");
    }
  }

  memo.status = state.status;
}

export function attachRunNotifier(scheduler: RunScheduler): NotifierHandle {
  const memo = createMemo();
  const unsubscribe = scheduler.on((state) => {
    try {
      notify(state, memo);
    } catch (err) {
      // Don't let a notifier failure break the view's subscription
      // — toasts are auxiliary.
      console.error("loop run-notifier: notify failed", err);
    }
  });
  return { dispose: unsubscribe };
}

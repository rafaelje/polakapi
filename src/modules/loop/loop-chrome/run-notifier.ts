// Subscribes to the scheduler and emits toasts for run lifecycle events.
// Tracks prior snapshots to dedupe — the scheduler emits many events per
// agent and we only want one toast per phase/batch.

import { showToast } from "../../../shared/ui/toast";
import type { RunScheduler, RunSchedulerState } from "../core/run-scheduler";

export interface NotifierHandle {
  dispose(): void;
}

interface NotifierMemo {
  status: RunSchedulerState["status"] | null;
  warnedPhases: Set<string>;
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

  for (const phase of state.phases) {
    if (phase.reviewerExhausted && !memo.warnedPhases.has(phase.slug)) {
      memo.warnedPhases.add(phase.slug);
      showToast(`phase "${phase.name}" hit the reviewer cap`, "warning");
    }
  }

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
      // Toasts are auxiliary — don't let a failure break the view subscription.
      console.error("loop run-notifier: notify failed", err);
    }
  });
  return { dispose: unsubscribe };
}

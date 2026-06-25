// Section 10.1 — bridge entre el RunScheduler y `shared/ui/toast.ts`.
//
// El módulo se suscribe al scheduler y emite toasts para eventos clave del
// run, de modo que el usuario tenga feedback inmediato sin tener que mirar
// el timeline detenidamente:
//
//   - run completado     → toast "success"
//   - fase con warning   → toast "warning" (una sola vez por fase)
//   - conflicto detectado→ toast "warning" con la lista de paths
//
// El notifier mantiene una pequeña máquina de estado interna que compara el
// snapshot anterior con el actual para no disparar toasts duplicados (el
// scheduler emite muchos eventos por agente — sin esto, "fase X con warning"
// dispararía 4-5 veces a medida que el knowledge agent corre y persiste).
//
// Patrón: sigue el "imperative listener" del resto del módulo /loop —
// `attachRunNotifier(scheduler)` devuelve un unsubscribe.

import { showToast } from "../../shared/ui/toast";
import type { RunScheduler, RunSchedulerState } from "./state/run-scheduler";

export interface NotifierHandle {
  dispose(): void;
}

interface NotifierMemo {
  status: RunSchedulerState["status"] | null;
  /** Slugs de las fases que ya gatillaron toast de warning. */
  warnedPhases: Set<string>;
  /** batchId de los integradores que ya gatillaron toast de conflict. */
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
  // 1. Transición a `completed`: run terminado OK.
  if (state.status === "completed" && memo.status !== "completed") {
    const phaseCount = state.phases.length;
    const warningCount = state.phases.filter((p) => p.reviewerExhausted).length;
    if (warningCount === 0) {
      showToast(`run completado · ${phaseCount} fase${phaseCount === 1 ? "" : "s"}`, "success");
    } else {
      showToast(
        `run completado con ${warningCount} warning${warningCount === 1 ? "" : "s"}`,
        "warning",
      );
    }
  }

  // 2. Fases que llegaron al cap del revisor — sólo una vez por fase.
  for (const phase of state.phases) {
    if (phase.reviewerExhausted && !memo.warnedPhases.has(phase.slug)) {
      memo.warnedPhases.add(phase.slug);
      showToast(`fase "${phase.name}" llegó al cap del revisor`, "warning");
    }
  }

  // 3. Integradores en conflict — uno por batch.
  for (const integrator of state.integrators) {
    if (integrator.status === "conflict" && !memo.conflictedBatches.has(integrator.batchId)) {
      memo.conflictedBatches.add(integrator.batchId);
      const n = integrator.conflicts.length;
      const summary =
        n === 0
          ? "sin paths reportados — revisá la card del integrador"
          : `${n} path${n === 1 ? "" : "s"} en conflicto`;
      showToast(`conflicto detectado en ${integrator.batchId} · ${summary}`, "warning");
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
      // No dejamos que un fallo del notifier rompa la suscripción de la vista
      // — los toasts son auxiliares.
      console.error("loop run-notifier: notify falló", err);
    }
  });
  return { dispose: unsubscribe };
}

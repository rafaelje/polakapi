// Chrome view of the /loop window: persistent header + slot for the steps.
//
// Follows the pattern of the workspaces panels (see
// `src/modules/workspaces/panel/workspaces-panel.ts`): the module exposes
// `mountLoopChrome(root, router)` which subscribes to the router and
// re-renders imperatively with `replaceChildren`. We don't introduce a
// framework; we keep consistency with the rest of the app.
//
// The renderers that don't need access to the live mount state (gates,
// header, resume banner) live in `loop-chrome/*.ts` siblings so this
// orchestrator stays focused on the (state → DOM) wiring and the two flow
// switches that need both the router and the scheduler — start of a fresh
// run and resume of an interrupted one.

import { invoke } from "@tauri-apps/api/core";

import { stringifyError } from "../../shared/errors";
import { showToast } from "../../shared/ui/toast";

import { renderInvalidPathGate, renderLoading, renderNoProjectGate } from "./loop-chrome/gates";
import { renderHeader, renderStepSlot } from "./loop-chrome/header";
import {
  probeForInterruptedRun,
  reconcileResumeBanner,
  setResumeActionHandler,
} from "./loop-chrome/resume-banner";
import type { MountedStep, ResumeAction, ResumeProbe } from "./loop-chrome/types";
import { attachRunNotifier } from "./run-notifier";
import {
  archiveRun,
  discardPartialOutputs,
  rewindRunningStages,
  type InterruptedRunDetails,
} from "./state/resume-detector";
import { RunScheduler } from "./state/run-scheduler";
import type { LoopRouter, LoopRouterState } from "./state/run-context";
import { mountStep1Chat } from "./step1-chat";
import { mountStep2Phases, parsePhasesManifest } from "./step2-phases";
import { mountStep3Run } from "./step3-run";
import { mountStep3Setup, type RunConfig } from "./step3-setup";

export interface LoopChromeHandle {
  dispose(): void;
}

/**
 * Mounts the chrome inside the given container (typically `#loop-root` from
 * `loop.html`). Returns a handle to clean up listeners if the window is
 * destroyed — equivalent to the pattern of `mountLoopButton` in
 * `loop-window.ts`.
 */
export function mountLoopChrome(root: HTMLElement, router: LoopRouter): LoopChromeHandle {
  let mountedStep: MountedStep | null = null;
  /**
   * Cache of the last scan for interrupted runs. We invalidate it when
   * `projectPath` changes (gate transition or change of the active
   * project). The banner is mounted once per project — if the user
   * dismisses it, `pending=null` and it doesn't appear again until the
   * project changes.
   */
  let resumeProbe: ResumeProbe | null = null;

  const handleExecuteRun = (config: RunConfig): void => {
    if (!mountedStep || mountedStep.step !== 3) return;
    const state = router.getState();
    if (state.status !== "active") return;
    // 1) Change the router step → the subscription re-renders with
    //    state.step=4, showing an empty placeholder.
    // 2) Trigger switchToRunView async to mount the scheduler + view on
    //    top of the placeholder. The `commit` callback updates mountedStep
    //    to {step:4, handle, scheduler, notifier}.
    router.setStep(4);
    const next = router.getState();
    if (next.status !== "active") return;
    void switchToRunView(root, router, next, config, mountedStep, (committed) => {
      mountedStep = committed;
    });
  };

  const rerender = (): void => {
    const state = router.getState();
    mountedStep = render(root, router, state, mountedStep, handleExecuteRun, resumeProbe);
  };

  const unsubscribe = router.on((state) => {
    if (state.status === "active") {
      // Do we need to scan? Only if the project changed or we never scanned.
      if (!resumeProbe || resumeProbe.projectPath !== state.project.path) {
        resumeProbe = { projectPath: state.project.path, pending: null, scanned: false };
        void probeForInterruptedRun(state.project.path).then((details) => {
          // Only apply if we are still in the same project — the user
          // may have changed it while the scan was in flight.
          if (resumeProbe && resumeProbe.projectPath === state.project.path) {
            resumeProbe.pending = details;
            resumeProbe.scanned = true;
            rerender();
          }
        });
      }
    } else {
      resumeProbe = null;
    }
    mountedStep = render(root, router, state, mountedStep, handleExecuteRun, resumeProbe);
  });

  const handleResumeAction = async (action: ResumeAction): Promise<void> => {
    if (!resumeProbe?.pending) return;
    const details = resumeProbe.pending;
    const state = router.getState();
    if (state.status !== "active") return;
    if (action === "archive") {
      try {
        await archiveRun(state.project.path, details.summary.runId);
      } catch (err) {
        console.error("loop chrome: archive run failed", err);
        showToast(`Could not archive run: ${stringifyError(err)}`, "error");
        return;
      }
      resumeProbe.pending = null;
      showToast("run archived", "info");
      rerender();
      return;
    }
    if (action === "dismiss") {
      resumeProbe.pending = null;
      rerender();
      return;
    }
    // action === "resume"
    try {
      await resumeInterruptedRun(root, state, details, router, (next) => {
        mountedStep = next;
      });
      if (resumeProbe) resumeProbe.pending = null;
    } catch (err) {
      console.error("loop chrome: resume run failed", err);
      showToast(`Could not resume run: ${stringifyError(err)}`, "error");
    }
  };

  // The banner module reads this handler when wiring its buttons — done via
  // a module-scoped setter to avoid passing the closure through every
  // renderer call.
  setResumeActionHandler(handleResumeAction);

  return {
    dispose: () => {
      unsubscribe();
      if (mountedStep?.handle) mountedStep.handle.dispose();
      if (mountedStep?.notifier) mountedStep.notifier.dispose();
      if (mountedStep?.scheduler) mountedStep.scheduler.abort();
      mountedStep = null;
      setResumeActionHandler(null);
    },
  };
}

function render(
  root: HTMLElement,
  router: LoopRouter,
  state: LoopRouterState,
  prev: MountedStep | null,
  onExecuteRun: (config: RunConfig) => void,
  resumeProbe: ResumeProbe | null,
): MountedStep | null {
  // When leaving "active" or changing runId/step, we need to unmount the
  // handle of the previous step to avoid leaking chat listeners.
  function disposePrev(): void {
    if (prev?.handle) prev.handle.dispose();
  }

  root.classList.add("loop-root");

  switch (state.status) {
    case "loading":
      disposePrev();
      root.replaceChildren(renderLoading());
      return null;
    case "no-project":
      disposePrev();
      root.replaceChildren(renderNoProjectGate());
      return null;
    case "invalid-path":
      disposePrev();
      root.replaceChildren(renderInvalidPathGate(state.project.name, state.project.path));
      return null;
    case "active":
      return renderActive(root, router, state, prev, onExecuteRun, resumeProbe);
  }
}

function renderActive(
  root: HTMLElement,
  router: LoopRouter,
  state: Extract<LoopRouterState, { status: "active" }>,
  prev: MountedStep | null,
  onExecuteRun: (config: RunConfig) => void,
  resumeProbe: ResumeProbe | null,
): MountedStep {
  // If we are still in the same (runId, step), we only refresh the header
  // — the step slot is already mounted with its internal state (chat with
  // its turns, running scheduler, etc.).
  const sameSlot = prev && prev.runId === state.runId && prev.step === state.step;
  if (sameSlot) {
    const shell = root.querySelector(".loop-shell");
    const header = root.querySelector(".loop-header");
    if (shell && header) {
      header.replaceWith(renderHeader(router, state, prev));
      reconcileResumeBanner(shell, resumeProbe);
      return prev;
    }
    // Fallback: if for some reason the DOM is not as we expect, we fall
    // back to a full re-render.
  }

  if (prev?.handle) prev.handle.dispose();
  if (prev?.notifier) prev.notifier.dispose();
  // We don't abort the scheduler if we are going to step 4 — the caller
  // (handleExecuteRun or resumeInterruptedRun) mounts it immediately
  // afterwards. We do abort on transitions between other steps.
  if (prev?.scheduler && state.step !== 4) prev.scheduler.abort();

  const shell = document.createElement("div");
  shell.className = "loop-shell";
  const header = renderHeader(router, state, prev);
  const slot = renderStepSlot(state.step);
  shell.append(header, slot);
  reconcileResumeBanner(shell, resumeProbe);
  root.replaceChildren(shell);

  const handle = mountStepForState(slot, state, router, onExecuteRun);

  return {
    runId: state.runId,
    step: state.step,
    handle,
    scheduler: null,
    notifier: null,
  };
}

function mountStepForState(
  slot: HTMLElement,
  state: Extract<LoopRouterState, { status: "active" }>,
  router: LoopRouter,
  onExecuteRun: (config: RunConfig) => void,
): MountedStep["handle"] {
  if (state.step === 1) {
    slot.replaceChildren();
    return mountStep1Chat(slot, {
      projectPath: state.project.path,
      runId: state.runId,
      onConsolidate: () => router.setStep(2),
      onAdoptRun: (runId, step) => router.adoptRunId(runId, step),
    });
  }
  if (state.step === 2) {
    slot.replaceChildren();
    return mountStep2Phases(slot, {
      projectPath: state.project.path,
      runId: state.runId,
      onAdvance: () => router.setStep(3),
    });
  }
  if (state.step === 3) {
    slot.replaceChildren();
    return mountStep3Setup(slot, {
      projectPath: state.project.path,
      projectName: state.project.name,
      suggestedCli: state.project.activeCliId ?? null,
      runId: state.runId,
      onExecuteRun,
    });
  }
  // step === 4: the run view is mounted by switchToRunView / resume; the
  // slot stays empty here.
  return null;
}

/**
 * Switch of the step 3 slot from the "setup" view to the "run" view. Reads
 * the phases of the run from `02-phases.md`, creates the scheduler with the
 * matrix + settings passed by the setup, initializes the timeline view and
 * starts the scheduler.
 *
 * Imperative on purpose: we don't introduce a global store of the scheduler
 * — it only lives while step 3 is mounted in "run" view. If the user
 * navigates away (step 1/2, abandon run, close window) we abort it in the
 * `dispose()` of the corresponding MountedStep.
 */
async function switchToRunView(
  root: HTMLElement,
  router: LoopRouter,
  state: Extract<LoopRouterState, { status: "active" }>,
  config: RunConfig,
  prev: MountedStep,
  commit: (next: MountedStep) => void,
): Promise<void> {
  // Read phases from the manifest persisted by step 2.
  let phases: ReturnType<typeof parsePhasesManifest> = [];
  try {
    const manifest = await invoke<string>("loop_read_run_file", {
      projectPath: state.project.path,
      runId: state.runId,
      file: "02-phases.md",
    });
    phases = manifest.trim() ? parsePhasesManifest(manifest) : [];
  } catch (err) {
    console.error("loop chrome: could not read 02-phases.md", err);
  }

  if (phases.length === 0) {
    // Without phases we cannot execute — we go back to setup and show a
    // toast. The validation in step3-setup already covers the happy-path
    // case (canExecute requires phases.length > 0), so this is a safeguard.
    showToast("No phases to execute — go back to Step 2 to decompose the problem.", "error");
    // Move the user out of step 4 (empty slot) back to setup.
    router.setStep(3);
    return;
  }

  // Dispose the current setup and open the slot for the new view.
  if (prev.handle) prev.handle.dispose();

  const shell = root.querySelector(".loop-shell");
  if (!shell) return;
  const oldSlot = shell.querySelector("#loop-step-slot");
  const newSlot = renderStepSlot(4);
  if (oldSlot) oldSlot.replaceWith(newSlot);
  else shell.appendChild(newSlot);

  const scheduler = new RunScheduler();
  scheduler.initialize(
    phases,
    {
      projectPath: state.project.path,
      runId: state.runId,
      matrix: config.matrix,
      promptOverrides: config.promptOverrides,
      maxRetries: config.config.maxRetries,
      // 300s aligned with the backend default; the step 3 setup does not
      // yet expose the per-run override. Section 8/9+ can add it if needed.
      agentTimeoutSecs: 300,
    },
    // Section 8: the mode comes from RunConfig (effectiveMode already
    // degraded "hybrid" to "sequential" if the DAG is linear — see
    // step3-setup).
    config.mode,
  );

  const handle = mountStep3Run(newSlot, {
    scheduler,
    projectName: state.project.name,
  });

  // Section 10.1 — auxiliary toasts (run completed, warning, conflict). We
  // attach it after mountStep3Run so the view subscribes first and
  // receives the initial state without toast noise.
  const notifier = attachRunNotifier(scheduler);

  commit({
    runId: state.runId,
    step: 4,
    handle,
    scheduler,
    notifier,
  });

  // Start the loop. The scheduler emits state through the listener — the
  // view is already subscribing and will re-render on every change. We
  // void the promise because the loop lasts for the entire run.
  void scheduler.start();
}

/**
 * Section 9.6 — resumes an interrupted run. Steps:
 *   1. Discard partial outputs (`<agent>.md` files without a `.diff` companion).
 *   2. Hydrate the scheduler with the persisted state (degrading stages
 *      running to pending via `rewindRunningStages`).
 *   3. Change the step 3 view to "run" — the user sees the timeline with
 *      the restored state.
 *   4. Call `scheduler.start()` to relaunch the loop from the last
 *      incomplete agent.
 *
 * We do NOT sync the router to step 3 before invoking — the slot switch is
 * done directly. This avoids an extra router commit that would trigger an
 * immediate re-render.
 */
async function resumeInterruptedRun(
  root: HTMLElement,
  state: Extract<LoopRouterState, { status: "active" }>,
  details: InterruptedRunDetails,
  router: LoopRouter,
  commit: (next: MountedStep) => void,
): Promise<void> {
  // 1. Discard partial outputs.
  const discarded = await discardPartialOutputs(state.project.path, details.summary.runId).catch(
    (err) => {
      console.error("loop chrome: discarding partial outputs failed", err);
      return [];
    },
  );
  if (discarded.length > 0) {
    console.info("loop resume: partial outputs discarded", discarded);
  }

  // Sync the router with the runId of the resumed run. If the router is
  // generating a new runId (default case), replace it with the one of the
  // persisted run. The router exposes `abandonRun` to regenerate; it does
  // not expose setRunId, so we navigate to step 4 (live run) — the chrome
  // reuses that slot to show the timeline of the resumed scheduler. The
  // router's runId doesn't matter to the timeline (we use the one from
  // details).
  router.setStep(4);

  // 2 + 3 + 4: rewind stages running → pending, hydrate scheduler, mount
  // run view, start the loop.
  const rewinded = rewindRunningStages(details.state);

  const shell = root.querySelector(".loop-shell");
  if (!shell) throw new Error("loop chrome: shell not found while resuming");

  const oldSlot = shell.querySelector("#loop-step-slot");
  const newSlot = renderStepSlot(3);
  if (oldSlot) oldSlot.replaceWith(newSlot);
  else shell.appendChild(newSlot);

  const scheduler = new RunScheduler();
  scheduler.hydrateFromPersisted(rewinded);

  const handle = mountStep3Run(newSlot, {
    scheduler,
    projectName: state.project.name,
  });

  const notifier = attachRunNotifier(scheduler);

  commit({
    runId: details.summary.runId,
    step: 4,
    handle,
    scheduler,
    notifier,
  });

  // Remove the banner now that the run is resumed.
  const banner = shell.querySelector(".loop-resume-banner");
  if (banner) banner.remove();

  // Start the loop. Since `rewindRunningStages` leaves `status: "paused"`,
  // `start()` will overwrite it to "running" and start from the first
  // pending stage of the first non-done phase.
  void scheduler.start();
}

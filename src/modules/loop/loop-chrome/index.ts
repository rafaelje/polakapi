import { invoke } from "@tauri-apps/api/core";

import { stringifyError } from "../../../shared/errors";
import { showToast } from "../../../shared/ui/toast";

import { renderInvalidPathGate, renderLoading, renderNoProjectGate } from "./gates";
import { renderHeader, renderStepSlot } from "./header";
import {
  probeForInterruptedRun,
  reconcileResumeBanner,
  setResumeActionHandler,
} from "./resume-banner";
import type { MountedStep, ResumeAction, ResumeProbe } from "./types";
import { attachRunNotifier } from "./run-notifier";
import {
  archiveRun,
  discardPartialOutputs,
  rewindRunningStages,
  type InterruptedRunDetails,
} from "../core/resume-detector";
import { RunScheduler } from "../core/run-scheduler";
import type { LoopRouter, LoopRouterState } from "../core/run-context";
import { mountStep1Chat } from "../step1-chat";
import { mountStep2Phases, parsePhasesManifest } from "../step2-phases";
import { mountStep3Run } from "../step4-run";
import { mountStep3Setup, type RunConfig } from "../step3-setup";

export interface LoopChromeHandle {
  dispose(): void;
}

export function mountLoopChrome(root: HTMLElement, router: LoopRouter): LoopChromeHandle {
  let mountedStep: MountedStep | null = null;
  // Cache of the last scan for interrupted runs, invalidated when projectPath
  // changes. If the user dismisses the banner, `pending=null` and it doesn't
  // appear again until the project changes.
  let resumeProbe: ResumeProbe | null = null;

  const handleExecuteRun = (config: RunConfig): void => {
    if (!mountedStep || mountedStep.step !== 3) return;
    const state = router.getState();
    if (state.status !== "active") return;
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

  // Module-scoped setter avoids threading the closure through every renderer.
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
  // Unmount the previous step's handle to avoid leaking chat listeners when
  // leaving "active" or changing runId/step.
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
  // Same (runId, step): only refresh the header so the step slot keeps its
  // internal state (chat turns, running scheduler, etc.).
  const sameSlot = prev && prev.runId === state.runId && prev.step === state.step;
  if (sameSlot) {
    const shell = root.querySelector(".loop-shell");
    const header = root.querySelector(".loop-header");
    if (shell && header) {
      header.replaceWith(renderHeader(router, state, prev));
      reconcileResumeBanner(shell, resumeProbe);
      return prev;
    }
    // Fall through to full re-render if the DOM isn't as expected.
  }

  if (prev?.handle) prev.handle.dispose();
  if (prev?.notifier) prev.notifier.dispose();
  // Don't abort the scheduler when going to step 4 — the caller mounts it
  // immediately afterwards. Abort on transitions between other steps.
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
  // step === 4: switchToRunView / resumeInterruptedRun replace the slot
  // immediately. Recovery gate is the fallback if neither takes over.
  slot.replaceChildren(renderStep4RecoveryGate(() => router.setStep(3)));
  return null;
}

function renderStep4RecoveryGate(onBack: () => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "loop-step4-recovery";
  const msg = document.createElement("p");
  msg.textContent = "Starting run…";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "loop-btn loop-btn-ghost";
  btn.textContent = "back to step 3";
  btn.addEventListener("click", () => onBack());
  wrap.append(msg, btn);
  return wrap;
}

async function switchToRunView(
  root: HTMLElement,
  router: LoopRouter,
  state: Extract<LoopRouterState, { status: "active" }>,
  config: RunConfig,
  prev: MountedStep,
  commit: (next: MountedStep) => void,
): Promise<void> {
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
    showToast("No phases to execute — go back to Step 2 to decompose the problem.", "error");
    router.setStep(3);
    return;
  }

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
      // Aligned with the backend default; step 3 setup does not yet expose a
      // per-run override.
      agentTimeoutSecs: 300,
    },
    config.mode,
  );

  const handle = mountStep3Run(newSlot, {
    scheduler,
    projectName: state.project.name,
  });

  // Attach after mountStep3Run so the view subscribes first and receives the
  // initial state without toast noise.
  const notifier = attachRunNotifier(scheduler);

  commit({
    runId: state.runId,
    step: 4,
    handle,
    scheduler,
    notifier,
  });

  // The loop lasts for the entire run; promise is intentionally voided.
  void scheduler.start();
}

async function resumeInterruptedRun(
  root: HTMLElement,
  state: Extract<LoopRouterState, { status: "active" }>,
  details: InterruptedRunDetails,
  router: LoopRouter,
  commit: (next: MountedStep) => void,
): Promise<void> {
  const discarded = await discardPartialOutputs(state.project.path, details.summary.runId).catch(
    (err) => {
      console.error("loop chrome: discarding partial outputs failed", err);
      return [];
    },
  );
  if (discarded.length > 0) {
    console.info("loop resume: partial outputs discarded", discarded);
  }

  // The router exposes `abandonRun` to regenerate but not `setRunId`, so we
  // navigate to step 4 and let the chrome reuse that slot for the resumed
  // scheduler's timeline. The router's runId is irrelevant to the timeline
  // (we use the one from `details`).
  router.setStep(4);

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

  const banner = shell.querySelector(".loop-resume-banner");
  if (banner) banner.remove();

  // `rewindRunningStages` leaves status="paused"; `start()` overwrites it
  // to "running" and resumes from the first pending stage.
  void scheduler.start();
}

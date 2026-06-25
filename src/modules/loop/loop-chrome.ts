// Chrome view of the /loop window: persistent header + slot for the steps.
//
// Follows the pattern of the workspaces panels (see
// `src/modules/workspaces/panel/workspaces-panel.ts`): the module exposes
// `mountLoopChrome(root, router)` which subscribes to the router and re-renders
// imperatively with `replaceChildren`. We don't introduce a framework; we keep
// consistency with the rest of the app.
//
// The components for each step (1=chat, 2=phases, 3=setup+engine) are mounted by
// later sections within the `#loop-step-slot` slot that this function
// creates. For now we place descriptive placeholders so the chrome is
// inspectable end-to-end.

import { mountStep1Chat, type Step1Handle } from "./step1-chat";
import { mountStep2Phases, type Step2Handle, parsePhasesManifest } from "./step2-phases";
import { mountStep3Run, type Step3RunHandle } from "./step3-run";
import { mountStep3Setup, type RunConfig, type Step3Handle } from "./step3-setup";
import { attachRunNotifier, type NotifierHandle } from "./run-notifier";
import { RunScheduler } from "./state/run-scheduler";
import { confirmModal } from "../../shared/ui/modal";
import { showToast } from "../../shared/ui/toast";
import {
  archiveRun,
  discardPartialOutputs,
  listInterruptedRuns,
  loadInterruptedRunDetails,
  rewindRunningStages,
  type InterruptedRunDetails,
} from "./state/resume-detector";
import type { LoopRouter, LoopRouterState, LoopStep } from "./state/run-context";
import { invoke } from "@tauri-apps/api/core";

export interface LoopChromeHandle {
  dispose(): void;
}

/**
 * Identity of the step slot to avoid unnecessary re-mounts. The chat
 * of step 1 (Section 4) keeps history in-memory; if the chrome
 * re-renders due to a router focus refresh, we don't want to lose the
 * turns. We only re-mount the slot when (runId, step, view) changes — the
 * transition between projects already regenerates the runId via `LoopRouter.refresh`.
 *
 * `view` distinguishes the 2 sub-views of step 3:
 * Step 3 mounts `step3-setup.ts` (pre-execution configuration) and step 4 mounts
 * `step3-run.ts` (timeline of the running run). The scheduler only lives
 * while we are in step 4; steps 1/2/3 discard it when re-mounting.
 */
interface MountedStep {
  runId: string;
  step: LoopStep;
  handle: Step1Handle | Step2Handle | Step3Handle | Step3RunHandle | null;
  /** Live scheduler when we are in step 4. null in any other step. */
  scheduler: RunScheduler | null;
  /**
   * Section 10.1 — handle of the notifier that listens to the scheduler and emits toasts.
   * Only lives while `scheduler !== null`. We dispose it together with the scheduler
   * in `dispose()` or when we re-mount the slot.
   */
  notifier: NotifierHandle | null;
}

/**
 * Mounts the chrome inside the given container (typically `#loop-root` from
 * `loop.html`). Returns a handle to clean up listeners if the window is
 * destroyed — equivalent to the pattern of `mountLoopButton` in `loop-window.ts`.
 */
/**
 * Section 9: composite ID that identifies the last detection of interrupted
 * runs for a project. We use it to avoid re-scanning the FS on every
 * focus refresh of the router — only when the active project changes.
 */
interface ResumeProbe {
  projectPath: string;
  /** Result of the last detection. null = already decided (resume/archive/dismiss). */
  pending: InterruptedRunDetails | null;
  /** True if the scan already ran for this project. False = pending scan. */
  scanned: boolean;
}

export function mountLoopChrome(root: HTMLElement, router: LoopRouter): LoopChromeHandle {
  let mountedStep: MountedStep | null = null;
  /**
   * Section 9: cache of the last scan for interrupted runs. We invalidate it
   * when `projectPath` changes (gate transition or change of the active
   * project). The banner is mounted once per project — if the user
   * dismisses it, `pending=null` and it doesn't appear again until the project changes.
   */
  let resumeProbe: ResumeProbe | null = null;

  const handleExecuteRun = (config: RunConfig): void => {
    if (!mountedStep || mountedStep.step !== 3) return;
    const state = router.getState();
    if (state.status !== "active") return;
    // 1) Change the router step → the subscription re-renders with
    //    state.step=4, showing an empty placeholder.
    // 2) Trigger switchToRunView async to mount the scheduler + view
    //    on top of the placeholder. The `commit` callback updates mountedStep
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

  const handleResumeAction = async (action: "resume" | "archive" | "dismiss"): Promise<void> => {
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

  // We attach the handler to the chrome through a dataset hook that renderResumeBanner
  // reads when re-binding the button listeners. This avoids closures that
  // capture stale refs of MountedStep.
  resumeActionHandler = handleResumeAction;

  return {
    dispose: () => {
      unsubscribe();
      if (mountedStep?.handle) mountedStep.handle.dispose();
      if (mountedStep?.notifier) mountedStep.notifier.dispose();
      if (mountedStep?.scheduler) mountedStep.scheduler.abort();
      mountedStep = null;
      resumeActionHandler = null;
    },
  };
}

/**
 * Section 9.4 — scans the project looking for an interrupted run and, if it
 * finds one, loads its state.json to validate it. Returns the first resumable
 * run (typically there is only one; if there are more, the banner shows the most
 * recent — the backend list already comes sorted by heartbeat desc).
 *
 * If state.json is corrupt, we try the next one. If none
 * passes validation, we return null and the banner doesn't appear — the user
 * will see the normal flow of step 1.
 */
async function probeForInterruptedRun(projectPath: string): Promise<InterruptedRunDetails | null> {
  try {
    const list = await listInterruptedRuns(projectPath);
    for (const summary of list) {
      const details = await loadInterruptedRunDetails(projectPath, summary);
      if (details) return details;
    }
  } catch (err) {
    console.error("loop chrome: probe for interrupted runs failed", err);
  }
  return null;
}

/**
 * Module-scoped handler for the banner buttons. It is set in
 * `mountLoopChrome` and referenced from `renderResumeBanner`. We keep a
 * single global handler because there is only one chrome instance per window.
 */
let resumeActionHandler: ((action: "resume" | "archive" | "dismiss") => Promise<void>) | null =
  null;

function render(
  root: HTMLElement,
  router: LoopRouter,
  state: LoopRouterState,
  prev: MountedStep | null,
  onExecuteRun: (config: RunConfig) => void,
  resumeProbe: ResumeProbe | null,
): MountedStep | null {
  // When leaving "active" or changing runId/step, we need to unmount the handle
  // of the previous step to avoid leaking chat listeners.
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
  // If we are still in the same (runId, step), we only refresh the header — the
  // step slot is already mounted with its internal state (chat with its turns,
  // running scheduler, etc.).
  const sameSlot = prev && prev.runId === state.runId && prev.step === state.step;
  if (sameSlot) {
    const shell = root.querySelector(".loop-shell");
    const header = root.querySelector(".loop-header");
    if (shell && header) {
      header.replaceWith(renderHeader(router, state, prev));
      reconcileResumeBanner(shell, resumeProbe);
      return prev;
    }
    // Fallback: if for some reason the DOM is not as we expect, we fall back to
    // a full re-render.
  }

  if (prev?.handle) prev.handle.dispose();
  if (prev?.notifier) prev.notifier.dispose();
  // We don't abort the scheduler if we are going to step 4 — the caller (handleExecuteRun
  // or resumeInterruptedRun) mounts it immediately afterwards. We do abort on
  // transitions between other steps.
  if (prev?.scheduler && state.step !== 4) prev.scheduler.abort();

  const shell = document.createElement("div");
  shell.className = "loop-shell";
  const header = renderHeader(router, state, prev);
  const slot = renderStepSlot(state.step);
  shell.append(header, slot);
  reconcileResumeBanner(shell, resumeProbe);
  root.replaceChildren(shell);

  let handle: Step1Handle | Step2Handle | Step3Handle | Step3RunHandle | null = null;
  if (state.step === 1) {
    slot.replaceChildren();
    handle = mountStep1Chat(slot, {
      projectPath: state.project.path,
      runId: state.runId,
      onConsolidate: () => router.setStep(2),
      onAdoptRun: (runId, step) => router.adoptRunId(runId, step),
    });
  } else if (state.step === 2) {
    slot.replaceChildren();
    handle = mountStep2Phases(slot, {
      projectPath: state.project.path,
      runId: state.runId,
      onAdvance: () => router.setStep(3),
    });
  } else if (state.step === 3) {
    slot.replaceChildren();
    handle = mountStep3Setup(slot, {
      projectPath: state.project.path,
      projectName: state.project.name,
      suggestedCli: state.project.activeCliId ?? null,
      runId: state.runId,
      onExecuteRun,
    });
  }

  return {
    runId: state.runId,
    step: state.step,
    handle,
    scheduler: null,
    notifier: null,
  };
}

/**
 * Switch of the step 3 slot from the "setup" view to the "run" view. Reads the
 * phases of the run from `02-phases.md`, creates the scheduler with the matrix +
 * settings passed by the setup, initializes the timeline view and starts the
 * scheduler.
 *
 * It is still "imperative": we don't introduce a global store of the scheduler —
 * the scheduler only lives while step 3 is mounted in "run" view. If
 * the user navigates away (step 1/2, abandon run, close window) we
 * abort it in the `dispose()` of the corresponding MountedStep.
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
    // Without phases we cannot execute — we go back to setup and show a toast.
    // The validation in step3-setup already covers the happy-path case
    // (canExecute requires phases.length > 0), so this is a safeguard.
    showToast(
      "No phases to execute — go back to Step 2 to decompose the problem.",
      "error",
    );
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
      // 300s aligned with the backend default; the step 3 setup does not yet expose
      // the per-run override. Section 8/9+ can add it if needed.
      agentTimeoutSecs: 300,
    },
    // Section 8: the mode comes from RunConfig (effectiveMode already degraded
    // "hybrid" to "sequential" if the DAG is linear — see step3-setup).
    config.mode,
  );

  const handle = mountStep3Run(newSlot, {
    scheduler,
    projectName: state.project.name,
  });

  // Section 10.1 — auxiliary toasts (run completed, warning, conflict).
  // We attach it after mountStep3Run so the view subscribes
  // first and receives the initial state without toast noise.
  const notifier = attachRunNotifier(scheduler);

  commit({
    runId: state.runId,
    step: 4,
    handle,
    scheduler,
    notifier,
  });

  // Start the loop. The scheduler emits state through the listener — the view is
  // already subscribing and will re-render on every change. We void the promise
  // because the loop lasts for the entire run.
  void scheduler.start();
}

/**
 * Section 9.5 — "interrupted run detected · resume?" banner. We
 * insert it between the header and the step slot. If there is no pending run, the
 * function returns null and `reconcileResumeBanner` removes any previous banner.
 */
function renderResumeBanner(details: InterruptedRunDetails): HTMLElement {
  const banner = document.createElement("section");
  banner.className = "loop-resume-banner";
  banner.dataset.runId = details.summary.runId;
  // Section 10.6 — a11y. The banner is a passive notification (live region).
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "interrupted run detected");
  banner.setAttribute("aria-live", "polite");

  const icon = document.createElement("span");
  icon.className = "loop-resume-banner-icon";
  icon.textContent = "⏸";
  icon.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  body.className = "loop-resume-banner-body";

  const title = document.createElement("p");
  title.className = "loop-resume-banner-title";
  title.textContent = "interrupted run detected · resume?";

  const meta = document.createElement("p");
  meta.className = "loop-resume-banner-meta";
  const ageLabel = describeAge(details.summary.ageMs);
  const stage = details.state.currentStage ? ` · ${details.state.currentStage} in progress` : "";
  const phaseLabel =
    details.state.currentPhaseIndex >= 0 && details.state.phases[details.state.currentPhaseIndex]
      ? ` · phase ${details.state.phases[details.state.currentPhaseIndex].id}`
      : "";
  meta.textContent = `run ${shortRunId(details.summary.runId)}${phaseLabel}${stage} · last heartbeat ${ageLabel}`;

  body.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "loop-resume-banner-actions";

  const resume = document.createElement("button");
  resume.type = "button";
  resume.className = "loop-btn loop-btn-primary";
  resume.textContent = "resume";
  resume.dataset.resumeAction = "resume";
  resume.setAttribute("aria-label", "resume the interrupted run");

  const archive = document.createElement("button");
  archive.type = "button";
  archive.className = "loop-btn loop-btn-ghost";
  archive.textContent = "archive";
  archive.dataset.resumeAction = "archive";
  archive.setAttribute("aria-label", "archive the interrupted run");

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "loop-btn loop-btn-ghost loop-resume-banner-dismiss";
  dismiss.textContent = "×";
  dismiss.title = "hide this banner (does not archive or delete)";
  dismiss.setAttribute("aria-label", "hide resume banner");
  dismiss.dataset.resumeAction = "dismiss";

  // The handlers are set in `reconcileResumeBanner` after inserting the
  // banner into the DOM — this way we avoid capturing stale refs of MountedStep if
  // the chrome re-renders.
  actions.append(resume, archive, dismiss);
  banner.append(icon, body, actions);
  return banner;
}

/**
 * Section 9.5 — inserts/updates/removes the resume banner at the start of the
 * shell (after the header). Centralizes the decision so that both the
 * fast-path (sameSlot) and the full-render apply it the same way.
 */
function reconcileResumeBanner(shell: Element, resumeProbe: ResumeProbe | null): void {
  const existing = shell.querySelector<HTMLElement>(".loop-resume-banner");
  if (!resumeProbe?.pending) {
    if (existing) existing.remove();
    return;
  }
  const details = resumeProbe.pending;
  if (existing && existing.dataset.runId === details.summary.runId) {
    // Banner is already up to date; we reconnect handlers in case the previous render
    // cleared the closure.
    bindResumeBannerHandlers(existing);
    return;
  }
  const banner = renderResumeBanner(details);
  if (existing) existing.replaceWith(banner);
  else {
    // Insert after the header (first child).
    const header = shell.querySelector(".loop-header");
    if (header && header.nextSibling) {
      shell.insertBefore(banner, header.nextSibling);
    } else if (header) {
      shell.appendChild(banner);
    } else {
      shell.insertBefore(banner, shell.firstChild);
    }
  }
  bindResumeBannerHandlers(banner);
}

function bindResumeBannerHandlers(banner: HTMLElement): void {
  const buttons = banner.querySelectorAll<HTMLButtonElement>("button[data-resume-action]");
  for (const btn of buttons) {
    const action = btn.dataset.resumeAction as "resume" | "archive" | "dismiss" | undefined;
    if (!action) continue;
    btn.onclick = () => {
      if (!resumeActionHandler) return;
      // Block the button while the action runs to avoid double clicks.
      const all = banner.querySelectorAll<HTMLButtonElement>("button");
      for (const b of all) b.disabled = true;
      void resumeActionHandler(action).finally(() => {
        for (const b of all) b.disabled = false;
      });
    };
  }
}

function describeAge(ageMs: number): string {
  if (ageMs < 0) return "moments ago";
  if (ageMs === Number.MAX_SAFE_INTEGER || ageMs > 1_000_000_000_000) return "no heartbeat";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
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
 * We do NOT sync the router to step 3 before invoking — the slot switch
 * is done directly by `switchToRunViewWithScheduler`. This avoids an extra
 * router commit that would trigger an immediate re-render.
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
  // persisted run. We do this with a trick: the router exposes `abandonRun` to
  // regenerate; it does not expose setRunId. We navigate to step 4 (live run) — the
  // chrome reuses that slot to show the timeline of the resumed scheduler.
  // The router's runId doesn't matter to the timeline (we use the one from details).
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

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function renderLoading(): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "loop-gate";
  const p = document.createElement("p");
  p.className = "loop-gate-msg loop-gate-muted";
  p.textContent = "loading…";
  wrap.appendChild(p);
  return wrap;
}

function renderNoProjectGate(): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "loop-gate";
  const h = document.createElement("h2");
  h.className = "loop-gate-title";
  h.textContent = "Pick a project first";
  const p = document.createElement("p");
  p.className = "loop-gate-msg";
  p.textContent =
    "/loop operates on the workspace's active project. Open the main window and select one to start.";
  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "loop-btn loop-btn-primary";
  cta.textContent = "Open workspace";
  // Focus the main window: the label "main" matches Tauri's root window
  // by convention (the one opened by the app at startup). If it doesn't
  // exist, there isn't much more we can do from here.
  cta.addEventListener("click", () => {
    void focusMainWindow();
  });
  wrap.append(h, p, cta);
  return wrap;
}

async function focusMainWindow(): Promise<void> {
  try {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const all = await getAllWebviewWindows();
    const main = all.find((w) => w.label === "main") ?? all.find((w) => w.label !== "loop");
    if (main) {
      await main.unminimize();
      await main.show();
      await main.setFocus();
    }
  } catch (err) {
    console.error("Could not focus main window from /loop gate", err);
  }
}

function renderInvalidPathGate(name: string, path: string): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "loop-gate loop-gate-error";
  const h = document.createElement("h2");
  h.className = "loop-gate-title";
  h.textContent = "Invalid path";
  const p = document.createElement("p");
  p.className = "loop-gate-msg";
  p.textContent = `Project "${name}" points to a path that does not exist or is not accessible.`;
  const code = document.createElement("code");
  code.className = "loop-gate-path";
  code.textContent = path;
  const hint = document.createElement("p");
  hint.className = "loop-gate-msg loop-gate-muted";
  hint.textContent =
    "Go back to the workspace and fix the path (right click → change path) before using /loop.";
  wrap.append(h, p, code, hint);
  return wrap;
}

function renderHeader(
  router: LoopRouter,
  state: Extract<LoopRouterState, { status: "active" }>,
  prev: MountedStep | null,
): HTMLElement {
  const header = document.createElement("header");
  header.className = "loop-header";

  // Left block: project + run-id
  const left = document.createElement("div");
  left.className = "loop-header-left";

  const projectName = document.createElement("span");
  projectName.className = "loop-header-project";
  projectName.textContent = state.project.name;
  projectName.title = state.project.path;

  const sep1 = document.createElement("span");
  sep1.className = "loop-header-sep";
  sep1.textContent = "·";

  const runLabel = document.createElement("span");
  runLabel.className = "loop-header-run";
  // Short run-id (8 chars of the UUID) in the chrome; the full id remains
  // accessible via `title` for copy-paste when debugging a run.
  runLabel.textContent = `run ${shortRunId(state.runId)}`;
  runLabel.title = state.runId;

  left.append(projectName, sep1, runLabel);

  // Middle block: step indicator (navigable). Each pill is a button that changes
  // the current step via the router. If a scheduler is running and the user jumps
  // to another step, we ask for confirmation because we abort it.
  const steps = document.createElement("nav");
  steps.className = "loop-header-steps";
  steps.setAttribute("aria-label", "run steps");
  const schedulerLive =
    prev?.scheduler != null &&
    (prev.scheduler.getState().status === "running" ||
      prev.scheduler.getState().status === "paused");
  // Pill 4 is only enabled if there is a live scheduler (the user only
  // accesses step 4 via "▶ run" or by resuming an interrupted run).
  const hasScheduler = prev?.scheduler != null;
  for (const step of [1, 2, 3, 4] as const) {
    const isCurrent = step === state.step;
    const disabled = isCurrent || (step === 4 && !hasScheduler);
    steps.appendChild(
      renderStepPill(step, state.step, disabled, async () => {
        if (disabled) return;
        if (schedulerLive && state.step === 4 && step !== 4) {
          const ok = await confirmModal({
            title: "Leave the run in progress?",
            message:
              "A scheduler is running agents. If you go back to another step now, the agent in progress is aborted and the phase remains incomplete (resume can pick it up later).",
            confirmLabel: `go to step ${step}`,
            cancelLabel: "stay",
            danger: true,
          });
          if (!ok) return;
          prev?.scheduler?.abort();
        }
        router.setStep(step);
      }),
    );
  }

  // Right block: abandon
  const right = document.createElement("div");
  right.className = "loop-header-right";
  const abandon = document.createElement("button");
  abandon.type = "button";
  abandon.className = "loop-btn loop-btn-ghost";
  abandon.textContent = "abandon run";
  abandon.setAttribute("aria-label", "abandon current run");
  // Section 10.2 — modal confirmation before discarding progress. The message
  // adapts its tone depending on whether there is a run in progress (live scheduler) or only
  // the unsaved chat of step 1/2.
  const runIsLive =
    prev?.scheduler != null &&
    (prev.scheduler.getState().status === "running" ||
      prev.scheduler.getState().status === "paused");
  abandon.addEventListener("click", () => {
    void (async () => {
      const ok = await confirmModal({
        title: runIsLive ? "Abort the run in progress?" : "Abandon the current run?",
        message: runIsLive
          ? "The scheduler is running agents. If you abort now, the in-progress agent's outputs are discarded and the phase remains incomplete — the step 9 resume detects this case, but the in-flight work is still lost."
          : "The unsaved step 1/2 progress is discarded (drafts, phases without save, etc.).",
        confirmLabel: runIsLive ? "abort run" : "abandon",
        cancelLabel: "cancel",
        danger: true,
      });
      if (!ok) return;
      // If there is a live run, we abort the scheduler explicitly before
      // regenerating the runId — the dispose of MountedStep also does it, but
      // we want to make sure the scheduler releases the heartbeat and
      // persists the last state.json with status="aborted".
      if (prev?.scheduler) prev.scheduler.abort();
      router.abandonRun();
    })();
  });
  right.appendChild(abandon);

  header.append(left, steps, right);
  return header;
}

function renderStepPill(
  step: LoopStep,
  current: LoopStep,
  disabled: boolean,
  onClick: () => void | Promise<void>,
): HTMLElement {
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "loop-step-pill";
  if (step === current) pill.classList.add("loop-step-pill-current");
  if (step < current) pill.classList.add("loop-step-pill-done");
  pill.textContent = `${step}`;
  pill.setAttribute("aria-current", step === current ? "step" : "false");
  pill.setAttribute("aria-label", `${stepLabel(step)}${step === current ? " (current)" : ""}`);
  pill.title = stepLabel(step);
  pill.disabled = disabled;
  pill.addEventListener("click", () => {
    void onClick();
  });
  return pill;
}

function stepLabel(step: LoopStep): string {
  switch (step) {
    case 1:
      return "Step 1 · problem intake";
    case 2:
      return "Step 2 · phase decomposition";
    case 3:
      return "Step 3 · run setup";
    case 4:
      return "Step 4 · execution";
  }
}

function renderStepSlot(step: LoopStep): HTMLElement {
  const slot = document.createElement("section");
  slot.className = "loop-step-slot";
  slot.id = "loop-step-slot";
  slot.dataset.step = `${step}`;
  // Empty slot; steps 1–4 mount their content on top replacing the
  // children. If for some reason nobody mounts anything (inconsistent state),
  // the slot stays empty without confusing debug text.
  return slot;
}

function shortRunId(id: string): string {
  // UUID v4: `xxxxxxxx-xxxx-...` — the first 8 chars give virtually zero
  // collision for the simultaneous runs the user will handle.
  return id.split("-")[0] ?? id.slice(0, 8);
}

// Shared types for the /loop chrome — kept in their own module to avoid a
// cycle between the main chrome file and the helper modules it imports
// (header.ts needs `MountedStep` for the step-pill disabled logic, the chrome
// re-exports `LoopChromeHandle`, and so on).

import type { Step1Handle } from "../step1-chat";
import type { Step2Handle } from "../step2-phases";
import type { Step3RunHandle } from "../step3-run";
import type { Step3Handle } from "../step3-setup";
import type { NotifierHandle } from "../run-notifier";
import type { RunScheduler } from "../state/run-scheduler";
import type { InterruptedRunDetails } from "../state/resume-detector";
import type { LoopStep } from "../state/run-context";

/**
 * Identity of the step slot to avoid unnecessary re-mounts. The chat
 * of step 1 keeps history in-memory; if the chrome re-renders due to a
 * router focus refresh, we don't want to lose the turns. We only re-mount
 * the slot when (runId, step, view) changes — the transition between
 * projects already regenerates the runId via `LoopRouter.refresh`.
 *
 * `step === 4` distinguishes the run view: `step3-run.ts` (timeline of the
 * running run) is what mounts there. The scheduler only lives while we are
 * in step 4; steps 1/2/3 discard it when re-mounting.
 */
export interface MountedStep {
  runId: string;
  step: LoopStep;
  handle: Step1Handle | Step2Handle | Step3Handle | Step3RunHandle | null;
  /** Live scheduler when we are in step 4. null in any other step. */
  scheduler: RunScheduler | null;
  /**
   * Handle of the notifier that listens to the scheduler and emits toasts
   * (Section 10.1). Only lives while `scheduler !== null`. We dispose it
   * together with the scheduler in `dispose()` or when we re-mount.
   */
  notifier: NotifierHandle | null;
}

/**
 * Composite ID that identifies the last detection of interrupted runs for a
 * project. We use it to avoid re-scanning the FS on every focus refresh of
 * the router — only when the active project changes.
 */
export interface ResumeProbe {
  projectPath: string;
  /** Result of the last detection. null = already decided or never found. */
  pending: InterruptedRunDetails | null;
  /** True if the scan already ran for this project. */
  scanned: boolean;
}

export type ResumeAction = "resume" | "archive" | "dismiss";

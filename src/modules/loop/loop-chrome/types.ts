// Types live here to break a cycle: header.ts needs `MountedStep` for the
// step-pill disabled logic while the chrome re-exports `LoopChromeHandle`.

import type { Step1Handle } from "../step1-chat";
import type { Step2Handle } from "../step2-phases";
import type { Step3RunHandle } from "../step4-run";
import type { Step3Handle } from "../step3-setup";
import type { NotifierHandle } from "./run-notifier";
import type { RunScheduler } from "../core/run-scheduler";
import type { InterruptedRunDetails } from "../core/resume-detector";
import type { LoopStep } from "../core/run-context";

// Step 1's chat keeps history in-memory; we only re-mount the slot when
// (runId, step) changes so router focus refreshes don't drop turns. The
// scheduler only lives while step === 4.
export interface MountedStep {
  runId: string;
  step: LoopStep;
  handle: Step1Handle | Step2Handle | Step3Handle | Step3RunHandle | null;
  scheduler: RunScheduler | null;
  notifier: NotifierHandle | null;
}

// Cached so we don't re-scan the FS on every router focus refresh — only
// when the active project changes.
export interface ResumeProbe {
  projectPath: string;
  pending: InterruptedRunDetails | null;
  scanned: boolean;
}

export type ResumeAction = "resume" | "archive" | "dismiss";

import type { RunScheduler } from "../core/run-scheduler";

export interface Step3RunContext {
  scheduler: RunScheduler;
  projectName: string;
}

export interface Step3RunHandle {
  dispose(): void;
}

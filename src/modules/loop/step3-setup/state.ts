// Internal state shape + action set + view contract for step 3 setup.
// Lives in its own module so the renderer (view.ts) and pure helpers
// (helpers.ts) can import them without going through the main mount
// module — which would create a cycle.

import type { Phase } from "../step2-phases";
import type {
  CliValidation,
  LoopAgentRole,
  LoopCli,
  LoopProfile,
  LoopProfileId,
  LoopPromptName,
  ProfileMatrix,
} from "../state/types";

/** Execution mode of the run. */
export type RunMode = "sequential" | "hybrid";

/**
 * On-fail behavior. Read-only in this iteration — design.md decision #4
 * fixes "reviewer cap of 3 with warning propagation". We keep it as a
 * union so Section 7 can extend it without touching the shape.
 */
export type OnFailBehavior = "propagate-warning";

/**
 * Final snapshot the "▶ run" button passes to the engine. Section 7
 * consumes this.
 */
export interface RunConfig {
  mode: RunMode;
  matrix: ProfileMatrix;
  /**
   * Override per prompt: for each of the 7 prompts, run-edited content
   * (vs. the copy from the global). Only the modified ones appear here —
   * Section 7 uses the global by default.
   */
  promptOverrides: Partial<Record<LoopPromptName, string>>;
  config: {
    maxRetries: number;
    onFail: OnFailBehavior;
  };
}

export interface Step3Context {
  /** Absolute path of the active project. */
  projectPath: string;
  /** Readable name of the project (shown in the top bar). */
  projectName: string;
  /** Suggested CLI of the project (active chip from the workspace). */
  suggestedCli: string | null;
  /** UUID of the current run. */
  runId: string;
  /**
   * Callback when the user presses "▶ run". Optional so a future
   * standalone setup view can be inspected without the engine wired.
   */
  onExecuteRun?: (config: RunConfig) => void;
}

export type SlotValidation = CliValidation | { ok: null; reason: "pending" };

/** Internal state of the setup. */
export interface Step3State {
  /** Profiles loaded from `profiles.json`. */
  profiles: LoopProfile[];
  /** Id of the profile loaded in the UI (null = "no profile — all claude/opus-4-7"). */
  loadedProfileId: LoopProfileId | null;
  /** Current editable matrix (independent of `loadedProfileId` — hydrated from it on load). */
  matrix: ProfileMatrix;
  /** Execution mode chosen by the user. */
  mode: RunMode;
  /** Prompt selected in the sidebar. */
  selectedPrompt: LoopPromptName;
  /**
   * Editable buffers of the prompt textarea, indexed by name. If the
   * entry exists, that is the content on screen; if not, we read from the
   * run file and memoize it here.
   */
  promptBuffers: Map<LoopPromptName, string>;
  /** Content of the globals in memory, to compare default vs modified. */
  globals: Map<LoopPromptName, string>;
  /** Validations per slot (only applies to the 5 agents). */
  validations: Map<LoopAgentRole, SlotValidation>;
  /** Config row. `maxRetries` and `onFail` are read-only by design. */
  config: {
    maxRetries: number;
    onFail: OnFailBehavior;
  };
  /** Status message shown in the top bar (e.g. "profile saved", error). */
  status: string | null;
  /** If we are validating, saving or running, disables controls. */
  busy: boolean;
  /** Run phases, read from 02-phases.md, to detect "all linear". */
  phases: Phase[];
}

export type Step3Action =
  | { kind: "set-mode"; mode: RunMode }
  | { kind: "load-profile"; id: LoopProfileId | null }
  | { kind: "save-profile" }
  | { kind: "save-profile-as"; name: string }
  | { kind: "set-slot"; role: LoopAgentRole; cli: LoopCli; model: string }
  | { kind: "select-prompt"; name: LoopPromptName }
  | { kind: "set-prompt-buffer"; name: LoopPromptName; value: string }
  | { kind: "reset-to-global"; name: LoopPromptName }
  | { kind: "promote-to-global"; name: LoopPromptName }
  | { kind: "execute" };

export interface ViewRefs {
  refresh(): void;
  refreshValidationsOnly(): void;
  cleanup(): void;
}

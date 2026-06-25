// Internal state shape + action set + view contract for step 2. Pulled out
// of the main `step2-phases.ts` so the renderer (view.ts) can import them
// without going through the main module (which imports the renderer — a
// circular dependency otherwise).

import type { LoopCli } from "../state/types";

/** A step 2 phase according to the agent's JSON. */
export interface Phase {
  id: string;
  name: string;
  summary?: string;
  dependsOn: string[];
  hasVisual: boolean;
}

/** Disk state of a phase returned by `loop_list_phase_dirs`. */
export interface PhaseDirStatus {
  slug: string;
  hasLogic: boolean;
  hasVisual: boolean;
}

export type FileTab = "logic.md" | "visual.html";

export interface Step2State {
  /** List of phases ordered by id (1..N). */
  phases: Phase[];
  /** Slug of the phase selected in the sidebar, or null if none. */
  selectedSlug: string | null;
  /** Active tab of the main panel. */
  activeTab: FileTab;
  /** Disk state per slug — which files are materialized. */
  diskStatus: Map<string, PhaseDirStatus>;
  /** Editor buffer content (not saved yet) — keyed by `${slug}:${tab}`. */
  editorBuffers: Map<string, string>;
  /** Set of `${slug}:${tab}` keys with unsaved changes. */
  dirty: Set<string>;
  /** CLI chosen to invoke the step 2 agent / AI editing. */
  cli: LoopCli;
  /** Status message shown in the header (e.g. "saved", "generating…", error). */
  status: string | null;
  /** If we are generating phases or invoking AI, disables controls. */
  busy: boolean;
  /** Manifest validation error (cycles detected, etc.). */
  cycleError: string | null;
}

export type Step2Action =
  | { kind: "set-cli"; cli: LoopCli }
  | { kind: "select-phase"; slug: string }
  | { kind: "set-tab"; tab: FileTab }
  | { kind: "set-buffer"; slug: string; tab: FileTab; value: string }
  | { kind: "save" }
  | { kind: "ai-edit"; instruction: string }
  | { kind: "regenerate" }
  | { kind: "reset-prompt-to-global" }
  | { kind: "add-phase" }
  | { kind: "delete-phase"; slug: string }
  | { kind: "set-depends"; slug: string; deps: string[] }
  | { kind: "advance" };

export interface ViewRefs {
  refresh(): void;
  refreshToolbarOnly(): void;
  cleanup(): void;
  editorTextarea(): HTMLTextAreaElement | null;
}

export interface Step2Context {
  /** Absolute path of the active project. */
  projectPath: string;
  /** UUID of the current run. */
  runId: string;
  /** Callback when the user clicks "→ Step 3". Validated: all phases have logic.md. */
  onAdvance: () => void;
}

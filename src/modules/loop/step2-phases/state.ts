import type { LoopCli } from "../types";

export interface Phase {
  id: string;
  name: string;
  summary?: string;
  dependsOn: string[];
  hasVisual: boolean;
}

export interface PhaseDirStatus {
  slug: string;
  hasLogic: boolean;
  hasVisual: boolean;
}

export type FileTab = "logic.md" | "visual.html";

export interface Step2State {
  phases: Phase[];
  selectedSlug: string | null;
  activeTab: FileTab;
  diskStatus: Map<string, PhaseDirStatus>;
  /** Editor buffer content (not saved yet) — keyed by `${slug}:${tab}`. */
  editorBuffers: Map<string, string>;
  /** Set of `${slug}:${tab}` keys with unsaved changes. */
  dirty: Set<string>;
  cli: LoopCli;
  status: string | null;
  busy: boolean;
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
  projectPath: string;
  runId: string;
  onAdvance: () => void;
}

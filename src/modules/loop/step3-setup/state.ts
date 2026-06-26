import type { Phase } from "../step2-phases";
import type {
  CliValidation,
  LoopAgentRole,
  LoopCli,
  LoopProfile,
  LoopProfileId,
  LoopPromptName,
  ProfileMatrix,
} from "../types";

export type RunMode = "sequential" | "hybrid";

export type OnFailBehavior = "propagate-warning";

export interface RunConfig {
  mode: RunMode;
  matrix: ProfileMatrix;
  promptOverrides: Partial<Record<LoopPromptName, string>>;
  config: {
    maxRetries: number;
    onFail: OnFailBehavior;
  };
}

export interface Step3Context {
  projectPath: string;
  projectName: string;
  suggestedCli: string | null;
  runId: string;
  onExecuteRun?: (config: RunConfig) => void;
}

export type SlotValidation = CliValidation | { ok: null; reason: "pending" };

export interface Step3State {
  profiles: LoopProfile[];
  loadedProfileId: LoopProfileId | null;
  matrix: ProfileMatrix;
  mode: RunMode;
  selectedPrompt: LoopPromptName;
  promptBuffers: Map<LoopPromptName, string>;
  globals: Map<LoopPromptName, string>;
  validations: Map<LoopAgentRole, SlotValidation>;
  config: {
    maxRetries: number;
    onFail: OnFailBehavior;
  };
  status: string | null;
  busy: boolean;
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
  | { kind: "reseed-from-bundled"; name: LoopPromptName }
  | { kind: "promote-to-global"; name: LoopPromptName }
  | { kind: "execute" };

export interface ViewRefs {
  refresh(): void;
  refreshValidationsOnly(): void;
  cleanup(): void;
}

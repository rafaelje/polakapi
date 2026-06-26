// Branded IDs + flat serializable shapes — this module's state is persisted to
// disk via tauri-plugin-store and must stay trivially cloneable.

import type { ProjectId } from "../workspaces/state/types";

export type { ProjectId };

export type LoopProfileId = string & { readonly __brand: "LoopProfileId" };

export type LoopCli = "claude" | "codex" | "opencode";

// `integration` only runs in hybrid mode (between batches).
export type LoopAgentRole = "analysis" | "implementation" | "review" | "knowledge" | "integration";

export interface AgentSlot {
  cli: LoopCli;
  model: string;
}

// Explicit per-role properties (not `Record<LoopAgentRole, AgentSlot>`) so TS
// flags any role missing from a profile loaded from disk.
export interface ProfileMatrix {
  analysis: AgentSlot;
  implementation: AgentSlot;
  review: AgentSlot;
  knowledge: AgentSlot;
  integration: AgentSlot;
}

// `createdAt` is epoch millis to avoid Date parsing in the reader.
export interface LoopProfile {
  id: LoopProfileId;
  name: string;
  createdAt: number;
  matrix: ProfileMatrix;
}

export interface LoopProfilesState {
  profiles: LoopProfile[];
  schemaVersion: 1;
}

// Must be kept in sync with `loop_prompts::PROMPT_NAMES` in Rust — both copies
// are maintained manually.
export const LOOP_PROMPT_NAMES = [
  "problem-intake.md",
  "phase-decomposition.md",
  "analysis.md",
  "implementation.md",
  "review.md",
  "knowledge.md",
  "integration.md",
] as const;

export type LoopPromptName = (typeof LOOP_PROMPT_NAMES)[number];

export const DEFAULT_AGENT_SLOT: AgentSlot = {
  cli: "claude",
  model: "claude-opus-4-7",
};

export function createDefaultMatrix(): ProfileMatrix {
  return {
    analysis: { ...DEFAULT_AGENT_SLOT },
    implementation: { ...DEFAULT_AGENT_SLOT },
    review: { ...DEFAULT_AGENT_SLOT },
    knowledge: { ...DEFAULT_AGENT_SLOT },
    integration: { ...DEFAULT_AGENT_SLOT },
  };
}

export interface CliValidation {
  ok: boolean;
  reason?: string | null;
}

export const LOOP_CLIS: readonly LoopCli[] = ["claude", "codex", "opencode"] as const;

// Execution order: analysis → impl → review → knowledge, plus the cross-batch integrator.
export const ALL_AGENT_ROLES: readonly LoopAgentRole[] = [
  "analysis",
  "implementation",
  "review",
  "knowledge",
  "integration",
] as const;

export function defaultModelFor(cli: LoopCli): string {
  switch (cli) {
    case "claude":
      return "claude-opus-4-7";
    case "codex":
      return "gpt-5";
    case "opencode":
      return "anthropic/claude-sonnet-4-5";
  }
}

// The 2 pre-phase prompts (`problem-intake`, `phase-decomposition`) have no
// agent role and return `null`.
export function promptToRole(name: LoopPromptName): LoopAgentRole | null {
  switch (name) {
    case "problem-intake.md":
    case "phase-decomposition.md":
      return null;
    case "analysis.md":
      return "analysis";
    case "implementation.md":
      return "implementation";
    case "review.md":
      return "review";
    case "knowledge.md":
      return "knowledge";
    case "integration.md":
      return "integration";
  }
}

export function promptBlurb(name: LoopPromptName): { title: string; io: string } {
  switch (name) {
    case "problem-intake.md":
      return {
        title: "Problem intake (pre-phase 1)",
        io: "input: chat with the user → output: consolidated 01-problem.md",
      };
    case "phase-decomposition.md":
      return {
        title: "Phase decomposition (pre-phase 2)",
        io: "input: 01-problem.md → output: JSON list of phases with dependsOn",
      };
    case "analysis.md":
      return {
        title: "Analysis (agent 1)",
        io: "input: phase logic.md + previous knowledge → output: analysis.md",
      };
    case "implementation.md":
      return {
        title: "Implementation (agent 2)",
        io: "input: analysis.md → output: repo changes + impl.md (diff snapshot)",
      };
    case "review.md":
      return {
        title: "Reviewer (agent 3, cap 3 retries)",
        io: "input: analysis.md + impl.md + diff → output: review.md (approved | needs-changes)",
      };
    case "knowledge.md":
      return {
        title: "Knowledge (agent 4)",
        io: "input: phase outputs → output: knowledge.md (≤ 2k tokens)",
      };
    case "integration.md":
      return {
        title: "Integrator (agent 5, hybrid mode only)",
        io: "input: knowledge.md from each phase in the batch + diffs → output: consolidated batch knowledge",
      };
  }
}

// Path separator is inferred from `projectPath` so Windows-native paths stay
// Windows-native; the backend resolves the result verbatim.
export function buildRunPromptPath(
  projectPath: string,
  runId: string,
  name: LoopPromptName,
): string {
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return [projectPath, ".loop", "runs", runId, "prompts", name].join(sep);
}

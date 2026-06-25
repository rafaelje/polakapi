// Types for the `/loop` module. We follow the workspaces store pattern
// (workspaces/state/types.ts) — IDs branded as `string & { __brand }`, flat
// shapes without classes. The reason is that the workspaces store is
// serialized to disk via tauri-plugin-store and we need it to be trivially
// cloneable.
//
// Here we only define what is needed for Section 2 (profiles + global
// prompts). The full `state.json` schema for a run lives in Section 9 (resume)
// and is added later without touching this file.

import type { ProjectId } from "../../workspaces/state/types";

export type { ProjectId };

/** Branded IDs so profile IDs don't get mixed up with other strings. */
export type LoopProfileId = string & { readonly __brand: "LoopProfileId" };

/**
 * The 3 supported CLIs, aligned with the `loop_cli.rs` spike. Any value
 * outside this union is rejected by the backend.
 */
export type LoopCli = "claude" | "codex" | "opencode";

/**
 * The 5 agents of Step 3. Matches 1:1 with the set in `loop-profiles/spec.md`
 * and the names used in the setup sidebar. `integration` only runs in hybrid
 * mode (between batches).
 */
export type LoopAgentRole = "analysis" | "implementation" | "review" | "knowledge" | "integration";

/**
 * Individual slot for an agent in a profile: CLI + model. The backend
 * validates this pair via `loop_validate_cli_model` when the profile is loaded.
 */
export interface AgentSlot {
  cli: LoopCli;
  model: string;
}

/**
 * Full matrix of a profile. We keep each agent as an explicit property
 * (instead of `Record<LoopAgentRole, AgentSlot>`) so TS catches on the fly
 * any role missing from a profile loaded from disk.
 */
export interface ProfileMatrix {
  analysis: AgentSlot;
  implementation: AgentSlot;
  review: AgentSlot;
  knowledge: AgentSlot;
  integration: AgentSlot;
}

/**
 * Persisted profile. Matches `profiles[]` in `profiles.json` (see
 * `loop-profiles/spec.md`). `createdAt` is stored as epoch millis (number)
 * to avoid Date parsing in the reader.
 */
export interface LoopProfile {
  id: LoopProfileId;
  name: string;
  createdAt: number;
  matrix: ProfileMatrix;
}

/**
 * Full state persisted in `profiles.json`. Same pattern as `WorkspacesState`:
 * numeric `schemaVersion` + array of items.
 */
export interface LoopProfilesState {
  profiles: LoopProfile[];
  schemaVersion: 1;
}

/**
 * The 7 canonical names of the global prompts. Identical to the set declared
 * in `loop_prompts::PROMPT_NAMES` in Rust. We keep both copies in sync
 * manually — if any changes, both sides must be touched.
 */
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

/**
 * Default that applies when no profile is loaded in setup. Aligned with
 * `loop-profiles/spec.md` ("default without profile loaded = all claude/opus-4-7").
 */
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

/**
 * Output of the Tauri command `loop_validate_cli_model`. `ok=true` => green
 * slot in the UI; `ok=false` with a human-readable `reason` to show to the user.
 */
export interface CliValidation {
  ok: boolean;
  reason?: string | null;
}

// ---------------------------------------------------------------------------
// Catalogs and constants
//
// Single source of truth for "which CLIs / agent roles / prompts the system
// knows about". Adding a new CLI, agent role, or pre-phase prompt means
// touching this file alone — every consumer iterates these constants
// instead of hardcoding their own copy.
// ---------------------------------------------------------------------------

/**
 * The 3 supported CLIs in iteration order — used by selectors, validators,
 * and the default-model lookup. Kept aligned with the `LoopCli` union above.
 */
export const LOOP_CLIS: readonly LoopCli[] = ["claude", "codex", "opencode"] as const;

/**
 * The 5 agent roles of Step 3 in execution order (analysis → impl → review
 * → knowledge, plus the cross-batch integrator). Iterated by the scheduler,
 * the setup sidebar, the timeline renderer, and validation.
 */
export const ALL_AGENT_ROLES: readonly LoopAgentRole[] = [
  "analysis",
  "implementation",
  "review",
  "knowledge",
  "integration",
] as const;

/**
 * Default model per CLI when no profile is loaded. Aligned with the design
 * doc's "default without profile loaded = all claude/opus-4-7" decision and
 * with the per-CLI defaults the spike validated.
 */
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

/**
 * Mapping prompt-name → agent role. The 2 pre-phase prompts (`problem-intake`
 * and `phase-decomposition`) don't have an agent role — they return `null`.
 */
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

/**
 * Readable description (title + input → output) per prompt. Drives the
 * blurb shown in the Step 3 setup sidebar.
 */
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

/**
 * Builds the path to a prompt file inside the run tree:
 *   `<projectPath>/.loop/runs/<runId>/prompts/<name>`
 *
 * The separator is inferred from `projectPath` so Windows-native paths stay
 * Windows-native. The backend resolves this path verbatim (see
 * `loop_prompts.rs::resolve_run_prompt`).
 */
export function buildRunPromptPath(
  projectPath: string,
  runId: string,
  name: LoopPromptName,
): string {
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return [projectPath, ".loop", "runs", runId, "prompts", name].join(sep);
}

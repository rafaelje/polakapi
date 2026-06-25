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
export type LoopAgentRole =
  | "analysis"
  | "implementation"
  | "review"
  | "knowledge"
  | "integration";

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

// Tipos del módulo `/loop`. Mantengo el patrón del store de workspaces
// (workspaces/state/types.ts) — IDs branded como `string & { __brand }`, shapes
// planos sin clases. La razón es que el store del workspace se serializa al
// disco vía tauri-plugin-store y necesitamos que sea trivialmente clonable.
//
// Sólo defino acá lo necesario para Section 2 (profiles + prompts globales). El
// schema completo del `state.json` de un run vive en Section 9 (resume) y se
// agrega después sin tocar este archivo.

import type { ProjectId } from "../../workspaces/state/types";

export type { ProjectId };

/** IDs branded para que los IDs de perfil no se mezclen con otros strings. */
export type LoopProfileId = string & { readonly __brand: "LoopProfileId" };

/**
 * Los 3 CLIs soportados, alineados con el spike de `loop_cli.rs`. Cualquier
 * valor fuera de este union es rechazado por el backend.
 */
export type LoopCli = "claude" | "codex" | "opencode";

/**
 * Los 5 agentes del Paso 3. Coincide 1:1 con el set de `loop-profiles/spec.md`
 * y con los nombres usados en el sidebar del setup. `integration` sólo corre
 * en modo híbrido (entre batches).
 */
export type LoopAgentRole =
  | "analysis"
  | "implementation"
  | "review"
  | "knowledge"
  | "integration";

/**
 * Slot individual de un agente en un perfil: CLI + modelo. El backend valida
 * este par vía `loop_validate_cli_model` cuando se carga el perfil.
 */
export interface AgentSlot {
  cli: LoopCli;
  model: string;
}

/**
 * Matriz completa de un perfil. Mantengo cada agente como propiedad explícita
 * (en vez de `Record<LoopAgentRole, AgentSlot>`) para que TS catche al vuelo
 * cualquier rol faltante en un perfil cargado del disco.
 */
export interface ProfileMatrix {
  analysis: AgentSlot;
  implementation: AgentSlot;
  review: AgentSlot;
  knowledge: AgentSlot;
  integration: AgentSlot;
}

/**
 * Perfil persistido. Coincide con `profiles[]` en `profiles.json` (ver
 * `loop-profiles/spec.md`). `createdAt` se guarda como epoch millis (number)
 * para evitar parseo de Date en el reader.
 */
export interface LoopProfile {
  id: LoopProfileId;
  name: string;
  createdAt: number;
  matrix: ProfileMatrix;
}

/**
 * Estado completo persistido en `profiles.json`. Mismo pattern que
 * `WorkspacesState`: `schemaVersion` numérico + arreglo de items.
 */
export interface LoopProfilesState {
  profiles: LoopProfile[];
  schemaVersion: 1;
}

/**
 * Los 7 nombres canónicos de los prompts globales. Idéntico al set declarado
 * en `loop_prompts::PROMPT_NAMES` en Rust. Mantenemos las dos copias en sync
 * manualmente — si alguno cambia, hay que tocar ambos lados.
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
 * Default que aplica cuando no hay perfil cargado en el setup. Alineado con
 * `loop-profiles/spec.md` ("default sin perfil cargado = todo claude/opus-4-7").
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
 * Output del comando Tauri `loop_validate_cli_model`. `ok=true` => slot verde
 * en el UI; `ok=false` con `reason` legible para mostrar al usuario.
 */
export interface CliValidation {
  ok: boolean;
  reason?: string | null;
}

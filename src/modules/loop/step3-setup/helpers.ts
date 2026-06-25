// Pure selectors over the step 3 setup state. Extracted from the mount
// module so they can be unit-tested without spinning up the DOM and so
// the renderer can use them without depending on the mount file.

import { topologicalBatches } from "../step2-phases";
import { ALL_AGENT_ROLES, type LoopPromptName } from "../state/types";

import type { RunMode, Step3State } from "./state";

/** Does the prompt buffer differ from the global loaded in memory? */
export function isPromptModified(state: Step3State, name: LoopPromptName): boolean {
  const buf = state.promptBuffers.get(name);
  if (buf === undefined) return false; // not loaded yet
  return buf !== (state.globals.get(name) ?? "");
}

/**
 * If the mode is hybrid but all phases fall into lanes of 1, the engine
 * degrades to sequential. This function returns the "effective" mode the
 * scheduler will use — Section 7+ should respect it.
 */
export function effectiveMode(state: Step3State): RunMode {
  if (state.mode !== "hybrid") return state.mode;
  if (state.phases.length === 0) return "hybrid";
  const batches = topologicalBatches(state.phases);
  if (!batches) return state.mode;
  return batches.every((b) => b.length === 1) ? "sequential" : "hybrid";
}

/** Number of slots with failed validation (excluding "pending"). */
export function countInvalidSlots(state: Step3State): number {
  let n = 0;
  for (const role of ALL_AGENT_ROLES) {
    const v = state.validations.get(role);
    if (v && "ok" in v && v.ok === false) n += 1;
  }
  return n;
}

/** Is the setup well-formed to run? Validations loaded and all ok. */
export function canExecute(state: Step3State): boolean {
  if (state.busy) return false;
  if (state.phases.length === 0) return false;
  for (const role of ALL_AGENT_ROLES) {
    const v = state.validations.get(role);
    if (!v) return false;
    if ("ok" in v && v.ok !== true) return false;
  }
  return true;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

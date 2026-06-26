import { topologicalBatches } from "../step2-phases";
import { ALL_AGENT_ROLES, type LoopPromptName } from "../types";

import type { RunMode, Step3State } from "./state";

export function isPromptModified(state: Step3State, name: LoopPromptName): boolean {
  const buf = state.promptBuffers.get(name);
  if (buf === undefined) return false;
  return buf !== (state.globals.get(name) ?? "");
}

export function effectiveMode(state: Step3State): RunMode {
  if (state.mode !== "hybrid") return state.mode;
  if (state.phases.length === 0) return "hybrid";
  const batches = topologicalBatches(state.phases);
  if (!batches) return state.mode;
  return batches.every((b) => b.length === 1) ? "sequential" : "hybrid";
}

export function countInvalidSlots(state: Step3State): number {
  let n = 0;
  for (const role of ALL_AGENT_ROLES) {
    const v = state.validations.get(role);
    if (v && "ok" in v && v.ok === false) n += 1;
  }
  return n;
}

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

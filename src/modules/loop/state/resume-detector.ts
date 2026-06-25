// Section 9 — detection of interrupted runs and resume helpers.
//
// When opening `/loop` on a project, the chrome calls `findInterruptedRun(...)`
// to detect whether there is a live run with a stale heartbeat. If there is,
// it mounts a banner ("interrupted run detected · resume?") with two actions:
//   - resume: discards partial outputs, hydrates the scheduler with the
//     persisted state, and starts the cycle from the last incomplete agent.
//   - archive: moves `<run>/` to `<project>/.loop/archived/<run>/` and shows
//     the normal flow again (step 1 empty).
//
// The parsing/validation of state.json lives in `state-schema.ts`. Here we
// only orchestrate the Tauri command invocations.

import { invoke } from "@tauri-apps/api/core";

import { parsePersistedRunState, type PersistedRunState } from "./state-schema";

/**
 * Minimal summary of an interrupted run returned by
 * `loop_list_interrupted_runs`. Matches `InterruptedRun` in Rust (camelCase
 * via serde rename).
 */
export interface InterruptedRunSummary {
  runId: string;
  /** Epoch ms of the last persisted heartbeat. 0 if there was never one. */
  lastHeartbeat: number;
  /** Heartbeat age in milliseconds at scan time. */
  ageMs: number;
}

/**
 * Result of loading the state.json of an interrupted run for the banner. If
 * the JSON is invalid or does not match the schema, we return `null` — the
 * caller should archive the run instead of trying to resume it.
 */
export interface InterruptedRunDetails {
  summary: InterruptedRunSummary;
  state: PersistedRunState;
}

/**
 * Lists interrupted runs of the project. Passes the staleness threshold in ms
 * to the backend (default 15s = N×3 with N=5s; Rust picks if not passed). In
 * tests the threshold can be raised to force/disable detection.
 */
export async function listInterruptedRuns(
  projectPath: string,
  staleThresholdMs?: number,
): Promise<InterruptedRunSummary[]> {
  return invoke<InterruptedRunSummary[]>("loop_list_interrupted_runs", {
    projectPath,
    staleThresholdMs: staleThresholdMs ?? null,
  });
}

/**
 * Reads + validates the `state.json` of a run to confirm it is resumable.
 * Returns `null` if the JSON is missing, fails to parse, or does not match
 * the schema.
 */
export async function loadInterruptedRunDetails(
  projectPath: string,
  summary: InterruptedRunSummary,
): Promise<InterruptedRunDetails | null> {
  const raw = await invoke<string>("loop_read_state_file", {
    projectPath,
    runId: summary.runId,
  }).catch(() => "");
  if (!raw) return null;
  const state = parsePersistedRunState(raw);
  if (!state) return null;
  return { summary, state };
}

/**
 * Discards partial outputs (`<agent>.md` files without a `<agent>.diff`
 * companion) of a run. Returns the list of deleted paths — useful for
 * showing the user what was discarded.
 */
export async function discardPartialOutputs(projectPath: string, runId: string): Promise<string[]> {
  return invoke<string[]>("loop_discard_partial_outputs", {
    projectPath,
    runId,
  });
}

/**
 * Archives an interrupted run: moves `<project>/.loop/runs/<id>/` to
 * `<project>/.loop/archived/<id>/`. Returns the destination path.
 */
export async function archiveRun(projectPath: string, runId: string): Promise<string> {
  return invoke<string>("loop_archive_run", {
    projectPath,
    runId,
  });
}

/**
 * Decides the "first pending stage" from a hydrated state. The scheduler
 * starts its cycle from `currentPhaseIndex`, but after discarding partial
 * outputs some "done" stages may end up inconsistent with disk — in that
 * case it is best to downgrade the stage to the first `pending`.
 *
 * Conservative strategy: if the `currentStage` was left as `running` at the
 * moment of the crash, we downgrade it to `pending`. The scheduler will
 * re-launch it when the cycle starts. Other "done" stages are preserved
 * (their outputs already have their `.diff` companion, they were not deleted).
 */
export function rewindRunningStages(state: PersistedRunState): PersistedRunState {
  const phases = state.phases.map((p) => {
    const stages = { ...p.stages };
    let downgraded = false;
    for (const agent of ["analysis", "implementation", "review", "knowledge"] as const) {
      if (stages[agent].status === "running") {
        stages[agent] = { ...stages[agent], status: "pending", message: undefined };
        downgraded = true;
      }
    }
    if (!downgraded) return p;
    // If we downgraded any stage to pending, the aggregate phase goes back to
    // "pending" too — the scheduler will recompute it on completion.
    return { ...p, stages, status: "pending" as const };
  });
  // Integrators in `running` also go back to `pending`. Their partial
  // knowledge.md may have been left on disk (we don't delete it because
  // `discard_partial_outputs` excludes the batches/ subdir), but the
  // scheduler will overwrite it when it re-runs.
  const integrators = state.integrators.map((i) =>
    i.status === "running" ? { ...i, status: "pending" as const, message: undefined } : i,
  );
  return {
    ...state,
    phases,
    integrators,
    currentStage: null,
    status: "paused",
    message: "run resumed from a crash · starting retry",
  };
}

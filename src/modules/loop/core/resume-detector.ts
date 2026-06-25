import { invoke } from "@tauri-apps/api/core";

import { parsePersistedRunState, type PersistedRunState } from "./state-schema";

// Matches `InterruptedRun` in Rust (camelCase via serde rename).
export interface InterruptedRunSummary {
  runId: string;
  // Epoch ms of the last persisted heartbeat. 0 if there was never one.
  lastHeartbeat: number;
  ageMs: number;
}

export interface InterruptedRunDetails {
  summary: InterruptedRunSummary;
  state: PersistedRunState;
}

// Default staleness threshold picked by Rust when not passed (15s = N×3 with N=5s).
export async function listInterruptedRuns(
  projectPath: string,
  staleThresholdMs?: number,
): Promise<InterruptedRunSummary[]> {
  return invoke<InterruptedRunSummary[]>("loop_list_interrupted_runs", {
    projectPath,
    staleThresholdMs: staleThresholdMs ?? null,
  });
}

// Returns `null` if the JSON is missing, fails to parse, or does not match the schema.
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

// Deletes `<agent>.md` files without a `<agent>.diff` companion. Returns the
// list of deleted paths so the UI can show the user what was discarded.
export async function discardPartialOutputs(projectPath: string, runId: string): Promise<string[]> {
  return invoke<string[]>("loop_discard_partial_outputs", {
    projectPath,
    runId,
  });
}

// Moves `<project>/.loop/runs/<id>/` to `<project>/.loop/archived/<id>/`,
// returning the destination path.
export async function archiveRun(projectPath: string, runId: string): Promise<string> {
  return invoke<string>("loop_archive_run", {
    projectPath,
    runId,
  });
}

// Conservative resume strategy: any stage left in `running` at crash time is
// downgraded to `pending` so the scheduler will re-launch it. Stages already
// `done` are preserved — their `.md`+`.diff` companion outputs survived the
// partial-output sweep.
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
    return { ...p, stages, status: "pending" as const };
  });
  // Integrators' partial knowledge.md may survive on disk because
  // `discard_partial_outputs` excludes the batches/ subdir; the scheduler
  // overwrites it when it re-runs.
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

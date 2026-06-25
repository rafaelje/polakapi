// Tauri-backed implementation of `SchedulerInvokers`. Lives in its own
// module so tests can avoid pulling `@tauri-apps/api/core` (which would
// require a webview at import time) — they swap in their own invokers
// instead.

import { invoke } from "@tauri-apps/api/core";

import type { AgentResult, SchedulerInvokers } from "./types";

export const defaultInvokers: SchedulerInvokers = {
  runAgent: (args) => invoke<AgentResult>("run_loop_agent", args),
  readOutput: (args) => invoke<string>("loop_read_output_file", args),
  writeOutput: (args) => invoke<void>("loop_write_output_file", args),
  writeState: (args) => invoke<void>("loop_write_state_file", args),
  gitDiffSnapshot: (args) => invoke<string>("loop_git_diff_snapshot", args),
  readPhaseFile: (args) => invoke<string>("loop_read_phase_file", args),
  readBatchFile: (args) => invoke<string>("loop_read_batch_file", args),
  writeBatchFile: (args) => invoke<void>("loop_write_batch_file", args),
};

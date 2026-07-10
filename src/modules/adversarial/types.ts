// Types for the /adversarial review feature. All shapes are flat / serializable
// — the debate scheduler mirrors its state to `state.json` on disk and reloads
// it on resume.

import type { LoopCli } from "../loop/types";

export type Severity = "critical" | "major" | "minor" | "nit";

export type PassRole = "critic" | "defender";

export type DebateAction = "new" | "maintain" | "withdraw" | "refute" | "concede" | "dispute";

// The lifecycle described in the plan §2.2:
//   open → confirmed | challenged → contested | withdrawn
//   contested → challenged (round loops)
//   still challenged/contested at exhaustion → disputed
export type FindingStatus =
  | "open"
  | "challenged"
  | "contested"
  | "confirmed"
  | "withdrawn"
  | "disputed";

// Effort ladder. `default` maps to no CLI flag; `xhigh` is Codex-only in v1.
export type Effort = "default" | "low" | "medium" | "high" | "xhigh";

export interface DebateSlot {
  cli: LoopCli;
  model: string;
  effort: Effort;
}

export interface FindingEvent {
  round: number;
  role: PassRole;
  action: DebateAction;
  // "(not addressed — implicit)" for implicit concede/withdraw. Trimmed to
  // ≤ 4000 chars so state.json does not blow up on rambly agents.
  argument: string;
}

export interface Finding {
  // "F1", "F2", … Assigned by the critic in round 1 and stable across rounds.
  id: string;
  file: string;
  line?: number;
  severity: Severity;
  claim: string;
  status: FindingStatus;
  history: FindingEvent[];
}

export interface FindingLedger {
  findings: Finding[];
  // The reducer is idempotent: applying the same pass twice must not
  // double-log. We record `{round, role}` per applied pass and skip repeats
  // on resume.
  appliedPasses: Array<{ round: number; role: PassRole }>;
}

export type DiffMode = "committed" | "working";

export interface DebateSettings {
  projectPath: string;
  runId: string;
  baseRef: string;
  mergeBase: string;
  headSha: string;
  rounds: number;
  critic: DebateSlot;
  defender: DebateSlot;
  blockingSeverity: Severity;
  timeoutSecs: number;
  // Repo-relative paths the diff was scoped to. Empty = whole branch diff.
  scopePaths: string[];
  // "committed" = merge-base…HEAD (default); "working" = uncommitted work vs HEAD.
  diffMode: DiffMode;
}

export type PassStatus = "pending" | "running" | "done" | "error";

export interface PassRecord {
  round: number;
  role: PassRole;
  status: PassStatus;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  retries: number;
  message?: string;
  startedAt?: number;
  endedAt?: number;
}

export type DebateStatus = "idle" | "running" | "paused" | "completed" | "aborted" | "error";

export interface DebateState {
  status: DebateStatus;
  settings: DebateSettings;
  passes: PassRecord[];
  findings: FindingLedger;
  totals: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  lastHeartbeat: number;
  diffTruncated: boolean;
  // Files auto-dropped by the generated-file filter (lockfiles, dist/, minified,
  // …). Optional so state.json written before the filter existed still loads.
  diffFilesExcluded?: string[];
  // Files whose per-file body exceeded the cap and was cut at a line boundary.
  diffFilesTruncated?: string[];
}

/// Signal returned by the branch-diff command so the frontend can render a
/// meaningful warning without re-fetching or re-parsing the diff.
export interface DiffMeta {
  truncated: boolean;
  filesExcluded: string[];
  filesTruncated: string[];
}

// Must stay in sync with the Rust `is_adversarial_prompt` allowlist.
export const ADVERSARIAL_PROMPT_NAMES = [
  "adversarial-critic.md",
  "adversarial-defender.md",
] as const;

export type AdversarialPromptName = (typeof ADVERSARIAL_PROMPT_NAMES)[number];

export const DEFAULT_ROUNDS = 2;
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 3;
export const DEFAULT_BLOCKING: Severity = "major";
export const DEFAULT_TIMEOUT_SECS = 600;

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  nit: 1,
};

export function severityAtOrAbove(sev: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[sev] >= SEVERITY_RANK[threshold];
}

export function defaultSlot(cli: LoopCli): DebateSlot {
  return {
    cli,
    model: defaultModelForCli(cli),
    effort: "default",
  };
}

export function defaultModelForCli(cli: LoopCli): string {
  switch (cli) {
    case "claude":
      return "claude-opus-4-7";
    case "codex":
      return "gpt-5.5";
    case "opencode":
      return "opencode-go/glm-5.2";
  }
}

// v1 policy: only `codex` maps `effort` to a CLI flag. The others accept the
// value but the Rust side logs and ignores it.
export function cliSupportsEffort(cli: LoopCli): boolean {
  return cli === "codex";
}

export function buildRunFilePath(projectPath: string, runId: string, file: string): string {
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return [projectPath, ".adversarial", "runs", runId, file].join(sep);
}

export function buildRunPromptPath(
  projectPath: string,
  runId: string,
  name: AdversarialPromptName,
): string {
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return [projectPath, ".adversarial", "runs", runId, "prompts", name].join(sep);
}

/** Wire types mirroring the Rust `agent_context_*` commands (serde camelCase). */

export type EntryKind =
  | "instructions"
  | "user-prompt"
  | "assistant-text"
  | "thinking"
  | "tool-call"
  | "file-content"
  | "tool-output";

export interface ProcessStats {
  rssMb: number;
  cpuPercent: number;
  uptimeSecs: number;
  pid: number | null;
}

export interface AgentSummary {
  ptyId: string;
  cli: string;
  cwd: string | null;
  /** Last path component of the cwd, used to group the list by project. */
  project: string | null;
  model: string | null;
  contextTokens: number;
  contextLimit: number;
  /** False when no transcript could be read for this pane. */
  readable: boolean;
  /** RSS, CPU and uptime of the pane's whole process tree. */
  process: ProcessStats;
}

export interface ContextBreakdown {
  instructions: number;
  files: number;
  toolOutput: number;
  messages: number;
  thinking: number;
}

export interface ContextEntry {
  id: number;
  kind: EntryKind;
  label: string;
  detail: string | null;
  timestamp: string | null;
  chars: number;
  estTokens: number;
  preview: string;
  truncated: boolean;
}

export interface ContextIdentity {
  sessionId: string | null;
  transcriptPath: string | null;
}

export interface ContextDetail {
  identity: ContextIdentity;
  summary: AgentSummary;
  breakdown: ContextBreakdown;
  entries: ContextEntry[];
  /** Set when there is nothing to read, explaining why. */
  note: string | null;
}

export type SortMode = "oldest" | "newest" | "largest" | "smallest";

export interface SearchHit {
  entryId: number;
  matches: number;
  /** Text around the first match, newlines flattened. */
  snippet: string;
}

export type BreakdownKey = keyof ContextBreakdown;

export interface BreakdownRow {
  key: BreakdownKey;
  label: string;
  tokens: number;
  percent: number;
}

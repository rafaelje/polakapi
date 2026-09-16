import type { ProjectId } from "../workspaces/state/types";

/** Wire types mirroring the Rust `agent_context` command (serde camelCase). */

export interface ToolCount {
  name: string;
  count: number;
}

export interface PaneContext {
  ptyId: string;
  /** "claude" or "codex" when a transcript was parsed, "none" when there is none. */
  source: "claude" | "codex" | "none";
  model: string | null;
  contextTokens: number;
  contextLimit: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  turns: number;
  tools: ToolCount[];
  files: string[];
  sessionId: string | null;
  rssMb: number;
  cpuPercent: number;
  uptimeSecs: number;
  pid: number | null;
}

export interface AgentContextReport {
  panes: PaneContext[];
  totalMb: number;
  availableMb: number;
}

export interface PaneQuery {
  ptyId: string;
  cliId?: string;
  cwd?: string;
}

/** A live pane joined with the project it belongs to, ready to render. */
export interface ContextRow {
  ptyId: string;
  projectId: ProjectId;
  label: string;
  cliId: string;
  lastActivityAt: number;
  context: PaneContext | null;
}

export interface ContextGroup {
  projectId: ProjectId;
  projectName: string;
  rows: ContextRow[];
}

import type { PaneSnapshot } from "../terminal/types";

export interface DetectedCli {
  id: string;
  label: string;
  command: string;
  path: string | null;
}

export interface AgentLaunchSpec {
  cli: string;
  cwd: string;
  command: string;
  args: string[];
}

export interface ControlRequest {
  id: number;
  method: string;
  params: unknown;
}

/** The agent's running PTY, handed between the bottom panel and its own window. */
export interface AgentSession {
  ptyId: string;
  exited: boolean;
  snapshot: PaneSnapshot | null;
}

export interface AgentHandoff {
  cli: string;
  session: AgentSession | null;
}

/** Emitted by the agent window to `main` on every start, stop, exit and close. */
export const AGENT_WINDOW_UPDATE_EVENT = "agent-window:update";
/** Emitted by Rust to `main` once the agent window is destroyed. */
export const AGENT_WINDOW_CLOSED_EVENT = "agent-window:closed";

export function isAgentHandoff(value: unknown): value is AgentHandoff {
  if (typeof value !== "object" || value === null) return false;
  const { cli, session } = value as Record<string, unknown>;
  if (typeof cli !== "string") return false;
  if (session === null) return true;
  if (typeof session !== "object" || session === undefined) return false;
  const { ptyId, exited } = session as Record<string, unknown>;
  return typeof ptyId === "string" && typeof exited === "boolean";
}

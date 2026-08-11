export type AgentId = "codex" | "claude" | "opencode";

export interface AgentSession {
  key: string;
  agent: AgentId;
  nativeId: string;
  title: string;
  cwd: string | null;
  createdAt: number;
  updatedAt: number;
  kind: string;
  status: string;
  archived: boolean;
  resumable: boolean;
}

export interface AgentSessionWarning {
  agent: string;
  message: string;
}

export interface AgentSessionsResult {
  sessions: AgentSession[];
  warnings: AgentSessionWarning[];
}

export interface AgentSessionResumeRequest {
  agent: AgentId;
  nativeId: string;
  title: string;
  cwd: string | null;
}

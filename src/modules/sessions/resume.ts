import type { Project, WorkspacesState } from "../workspaces/state/types";
import { pathsEqual } from "../path-comparison";
import type { AgentId, AgentSession, AgentSessionResumeRequest } from "./types";

export const AGENT_SESSION_RESUME_EVENT = "agent-session:resume";

export function toResumeRequest(session: AgentSession): AgentSessionResumeRequest {
  return {
    agent: session.agent,
    nativeId: session.nativeId,
    title: session.title,
    cwd: session.cwd,
  };
}

export function buildResumeLaunchArgs(agent: AgentId, nativeId: string): string[] {
  const id = nativeId.trim();
  if (!id) throw new Error("Session id is required");
  switch (agent) {
    case "codex":
      return ["resume", id];
    case "claude":
      return ["--resume", id];
    case "opencode":
      return ["--session", id];
  }
}

export function selectResumeProject(state: WorkspacesState, cwd: string | null): Project | null {
  if (cwd) {
    for (const workspace of state.workspaces) {
      const exact = workspace.projects.find((project) => pathsEqual(project.path, cwd));
      if (exact) return exact;
    }
  }
  if (!state.activeProjectId) return null;
  for (const workspace of state.workspaces) {
    const active = workspace.projects.find((project) => project.id === state.activeProjectId);
    if (active) return active;
  }
  return null;
}

export function isAgentSessionResumeRequest(value: unknown): value is AgentSessionResumeRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<AgentSessionResumeRequest>;
  return (
    (request.agent === "codex" || request.agent === "claude" || request.agent === "opencode") &&
    typeof request.nativeId === "string" &&
    request.nativeId.trim().length > 0 &&
    typeof request.title === "string" &&
    (request.cwd === null || typeof request.cwd === "string")
  );
}

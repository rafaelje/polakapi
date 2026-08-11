import type { AgentId, AgentSession } from "./types";

const SESSION_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export interface SessionFilters {
  needle: string;
  agent: AgentId | "all";
  kind: string;
  includeArchived: boolean;
}

export function filterSessions(
  sessions: readonly AgentSession[],
  filters: SessionFilters,
): AgentSession[] {
  const needle = filters.needle.trim().toLowerCase();
  return sessions.filter((session) => {
    if (!filters.includeArchived && session.archived) return false;
    if (filters.agent !== "all" && session.agent !== filters.agent) return false;
    if (filters.kind !== "all" && session.kind !== filters.kind) return false;
    if (!needle) return true;
    return [session.title, session.cwd ?? "", session.nativeId, session.agent, session.kind]
      .join("\n")
      .toLowerCase()
      .includes(needle);
  });
}

export function sessionStatusLabel(session: AgentSession): string {
  if (session.archived) return "archived";
  switch (session.status) {
    case "notLoaded":
      return "saved";
    case "systemError":
      return "error";
    default:
      return session.status || "saved";
  }
}

export function formatSessionTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "unknown time";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return SESSION_TIMESTAMP_FORMATTER.format(date);
}

import { describe, expect, it } from "vitest";
import { filterSessions, sessionStatusLabel } from "./sessions-model";
import type { AgentSession } from "./types";

const sessions: AgentSession[] = [
  {
    key: "codex:one",
    agent: "codex",
    nativeId: "one",
    title: "Global session browser",
    cwd: "/workspace/one",
    createdAt: 10,
    updatedAt: 20,
    kind: "interactive",
    status: "notLoaded",
    archived: false,
    resumable: true,
  },
  {
    key: "claude:two",
    agent: "claude",
    nativeId: "two",
    title: "Payment investigation",
    cwd: "/workspace/two",
    createdAt: 5,
    updatedAt: 15,
    kind: "subagent",
    status: "saved",
    archived: false,
    resumable: false,
  },
  {
    key: "opencode:three",
    agent: "opencode",
    nativeId: "three",
    title: "Archived work",
    cwd: null,
    createdAt: 1,
    updatedAt: 2,
    kind: "interactive",
    status: "saved",
    archived: true,
    resumable: true,
  },
];

describe("filterSessions", () => {
  it("combines provider, kind, text, and archive filters", () => {
    expect(
      filterSessions(sessions, {
        needle: "workspace/one",
        agent: "codex",
        kind: "interactive",
        includeArchived: false,
      }).map((session) => session.key),
    ).toEqual(["codex:one"]);
  });

  it("hides archived sessions by default and includes them on request", () => {
    const base = { needle: "", agent: "all" as const, kind: "all" };
    expect(filterSessions(sessions, { ...base, includeArchived: false })).toHaveLength(2);
    expect(filterSessions(sessions, { ...base, includeArchived: true })).toHaveLength(3);
  });
});

describe("sessionStatusLabel", () => {
  it("maps Codex notLoaded to saved and prioritizes archived state", () => {
    expect(sessionStatusLabel(sessions[0])).toBe("saved");
    expect(sessionStatusLabel(sessions[2])).toBe("archived");
  });
});

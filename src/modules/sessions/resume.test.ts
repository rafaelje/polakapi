import { describe, expect, it } from "vitest";
import type { ProjectId, WorkspaceId, WorkspacesState } from "../workspaces/state/types";
import { buildResumeLaunchArgs, selectResumeProject } from "./resume";

describe("buildResumeLaunchArgs", () => {
  it.each([
    ["codex", ["resume", "session-1"]],
    ["claude", ["--resume", "session-1"]],
    ["opencode", ["--session", "session-1"]],
  ] as const)("builds safe argv for %s", (agent, expected) => {
    expect(buildResumeLaunchArgs(agent, "session-1")).toEqual(expected);
  });

  it("rejects an empty native id", () => {
    expect(() => buildResumeLaunchArgs("codex", "   ")).toThrow("Session id is required");
  });
});

describe("selectResumeProject", () => {
  const activeId = "active" as ProjectId;
  const matchingId = "matching" as ProjectId;
  const state: WorkspacesState = {
    schemaVersion: 1,
    activeProjectId: activeId,
    workspaces: [
      {
        id: "workspace" as WorkspaceId,
        name: "Workspace",
        projects: [
          { id: activeId, name: "Active", path: "/active" },
          { id: matchingId, name: "Matching", path: "/session/path" },
        ],
      },
    ],
  };

  it("prefers the project matching the saved cwd", () => {
    expect(selectResumeProject(state, "/session/path")?.id).toBe(matchingId);
  });

  it("falls back to the active project", () => {
    expect(selectResumeProject(state, "/outside")?.id).toBe(activeId);
  });
});

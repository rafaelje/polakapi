import { describe, expect, it } from "vitest";
import type { ProjectId, WorkspaceId, WorkspacesState } from "../workspaces/state/types";
import { buildResumeLaunchArgs, isAgentSessionResumeRequest, selectResumeProject } from "./resume";

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

describe("isAgentSessionResumeRequest", () => {
  const validRequest = {
    agent: "codex",
    nativeId: "session-1",
    title: "Session",
    cwd: null,
  };

  it("accepts a valid request", () => {
    expect(isAgentSessionResumeRequest(validRequest)).toBe(true);
  });

  it.each([
    { ...validRequest, agent: "unknown" },
    { ...validRequest, nativeId: "   " },
    { ...validRequest, cwd: undefined },
  ])("rejects an invalid request", (request) => {
    expect(isAgentSessionResumeRequest(request)).toBe(false);
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

  it("matches Windows paths across casing, separators, and a trailing slash", () => {
    const windowsState: WorkspacesState = {
      ...state,
      workspaces: [
        {
          ...state.workspaces[0],
          projects: [
            state.workspaces[0].projects[0],
            {
              ...state.workspaces[0].projects[1],
              path: "C:\\Users\\Dev\\Polakapi",
            },
          ],
        },
      ],
    };

    expect(selectResumeProject(windowsState, "c:/users/dev/polakapi/")?.id).toBe(matchingId);
  });

  it("keeps POSIX path matching case-sensitive", () => {
    expect(selectResumeProject(state, "/SESSION/PATH")?.id).toBe(activeId);
  });
});

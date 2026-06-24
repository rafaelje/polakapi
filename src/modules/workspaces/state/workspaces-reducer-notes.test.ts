import { describe, expect, it } from "vitest";

import type { ProjectId, WorkspaceId } from "./types";
import {
  addProject,
  addWorkspace,
  createEmptyState,
  findProject,
  setProjectNotes,
} from "./workspaces-reducer";

function wsId(state: ReturnType<typeof createEmptyState>, idx: number): WorkspaceId {
  return state.workspaces[idx].id;
}

function projectIdAt(
  state: ReturnType<typeof createEmptyState>,
  wsIdx: number,
  pIdx: number,
): ProjectId {
  return state.workspaces[wsIdx].projects[pIdx].id;
}

describe("setProjectNotes", () => {
  it("writes the notes value onto the matching project", () => {
    let s = addWorkspace(createEmptyState(), "W");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
    const pid = projectIdAt(s, 0, 0);
    s = setProjectNotes(s, pid, "hello world");
    expect(findProject(s, pid)?.project.notes).toBe("hello world");
  });

  it("returns the same state reference when the value is unchanged", () => {
    let s = addWorkspace(createEmptyState(), "W");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
    const pid = projectIdAt(s, 0, 0);
    s = setProjectNotes(s, pid, "hello");
    const next = setProjectNotes(s, pid, "hello");
    expect(next).toBe(s);
  });

  it("treats undefined and '' as equivalent (no-op write on first focus)", () => {
    let s = addWorkspace(createEmptyState(), "W");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
    const pid = projectIdAt(s, 0, 0);
    // Project starts without notes (undefined). Writing '' must be identity.
    const next = setProjectNotes(s, pid, "");
    expect(next).toBe(s);
  });

  it("returns the same state reference when the project does not exist", () => {
    let s = addWorkspace(createEmptyState(), "W");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
    const ghost = "ghost-id" as ProjectId;
    const next = setProjectNotes(s, ghost, "anything");
    expect(next).toBe(s);
  });

  it("does not affect other projects", () => {
    let s = addWorkspace(createEmptyState(), "W");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p2", path: "/p2" });
    const p1 = projectIdAt(s, 0, 0);
    const p2 = projectIdAt(s, 0, 1);
    const p2Before = findProject(s, p2)!.project;
    s = setProjectNotes(s, p1, "only p1");
    expect(findProject(s, p1)?.project.notes).toBe("only p1");
    // p2 should be the exact same reference (referential isolation).
    expect(findProject(s, p2)!.project).toBe(p2Before);
    expect(findProject(s, p2)?.project.notes).toBeUndefined();
  });

  it("can overwrite an existing value with a different one", () => {
    let s = addWorkspace(createEmptyState(), "W");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
    const pid = projectIdAt(s, 0, 0);
    s = setProjectNotes(s, pid, "first");
    s = setProjectNotes(s, pid, "second");
    expect(findProject(s, pid)?.project.notes).toBe("second");
  });
});

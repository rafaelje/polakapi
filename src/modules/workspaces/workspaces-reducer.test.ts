import { describe, expect, it } from "vitest";

import type { ProjectId, TerminalSpec, WorkspaceId } from "./types";
import {
  addProject,
  addTerminalSpec,
  addWorkspace,
  changeProjectPath,
  createEmptyState,
  deleteProject,
  deleteWorkspace,
  duplicateProject,
  findProject,
  moveProject,
  removeTerminalSpec,
  renameProject,
  renameWorkspace,
  reorderProjects,
  reorderWorkspaces,
  replaceTerminalSpecs,
  resetAlphabeticalOrder,
  setActiveProject,
  setProjectPathInvalid,
  sortedProjects,
  sortedWorkspaces,
  toggleCollapsed,
  updateTerminalSpec,
} from "./workspaces-reducer";

function wsId(state: ReturnType<typeof createEmptyState>, idx: number): WorkspaceId {
  return state.workspaces[idx].id;
}

function projectId(
  state: ReturnType<typeof createEmptyState>,
  wsIdx: number,
  pIdx: number,
): ProjectId {
  return state.workspaces[wsIdx].projects[pIdx].id;
}

describe("workspaces-reducer", () => {
  it("createEmptyState returns a schemaVersion 1 empty doc", () => {
    expect(createEmptyState()).toEqual({
      workspaces: [],
      activeProjectId: null,
      schemaVersion: 1,
    });
  });

  it("addWorkspace appends a workspace with a uuid id", () => {
    const s = addWorkspace(createEmptyState(), "Alpha");
    expect(s.workspaces).toHaveLength(1);
    expect(s.workspaces[0].name).toBe("Alpha");
    expect(s.workspaces[0].id).toMatch(/[0-9a-f-]{36}/i);
    expect(s.workspaces[0].projects).toEqual([]);
  });

  it("renameWorkspace updates only the matching workspace", () => {
    let s = addWorkspace(createEmptyState(), "A");
    s = addWorkspace(s, "B");
    s = renameWorkspace(s, wsId(s, 0), "Renamed");
    expect(s.workspaces[0].name).toBe("Renamed");
    expect(s.workspaces[1].name).toBe("B");
  });

  it("toggleCollapsed flips the collapsed flag", () => {
    let s = addWorkspace(createEmptyState(), "A");
    s = toggleCollapsed(s, wsId(s, 0));
    expect(s.workspaces[0].collapsed).toBe(true);
    s = toggleCollapsed(s, wsId(s, 0));
    expect(s.workspaces[0].collapsed).toBe(false);
  });

  it("addProject appends a project to the right workspace", () => {
    let s = addWorkspace(createEmptyState(), "A");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/tmp/p1" });
    expect(s.workspaces[0].projects[0]).toMatchObject({ name: "p1", path: "/tmp/p1" });
  });

  it("renameProject, changeProjectPath and setProjectPathInvalid update only that project", () => {
    let s = addWorkspace(createEmptyState(), "A");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "old", path: "/old" });
    s = addProject(s, { workspaceId: wsId(s, 0), name: "other", path: "/other" });
    const pid = projectId(s, 0, 0);
    s = renameProject(s, pid, "new");
    s = changeProjectPath(s, pid, "/new");
    s = setProjectPathInvalid(s, pid, true);
    const p = findProject(s, pid)?.project;
    expect(p).toMatchObject({ name: "new", path: "/new", pathInvalid: true });
    // changing path clears the invalid flag
    s = changeProjectPath(s, pid, "/another");
    expect(findProject(s, pid)?.project.pathInvalid).toBe(false);
    expect(s.workspaces[0].projects[1].name).toBe("other");
  });

  it("deleteProject removes the project and clears activeProjectId if it pointed to it", () => {
    let s = addWorkspace(createEmptyState(), "A");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
    const pid = projectId(s, 0, 0);
    s = setActiveProject(s, pid);
    expect(s.activeProjectId).toBe(pid);
    s = deleteProject(s, pid);
    expect(s.workspaces[0].projects).toEqual([]);
    expect(s.activeProjectId).toBeNull();
  });

  it("deleteWorkspace removes the workspace and clears activeProjectId if it pointed to one of its projects", () => {
    let s = addWorkspace(createEmptyState(), "A");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
    const pid = projectId(s, 0, 0);
    s = setActiveProject(s, pid);
    s = deleteWorkspace(s, wsId(s, 0));
    expect(s.workspaces).toEqual([]);
    expect(s.activeProjectId).toBeNull();
  });

  it("duplicateProject inserts a copy with a new id right after the source", () => {
    let s = addWorkspace(createEmptyState(), "A");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "orig", path: "/o" });
    const original = projectId(s, 0, 0);
    s = duplicateProject(s, original);
    expect(s.workspaces[0].projects).toHaveLength(2);
    expect(s.workspaces[0].projects[1].name).toBe("orig (copy)");
    expect(s.workspaces[0].projects[1].id).not.toBe(original);
    expect(s.workspaces[0].projects[1].path).toBe("/o");
  });

  it("sortedWorkspaces and sortedProjects honor order, then name", () => {
    let s = createEmptyState();
    s = addWorkspace(s, "Banana");
    s = addWorkspace(s, "Apple");
    s = addWorkspace(s, "Zed");
    // Apply explicit order on Zed
    s = {
      ...s,
      workspaces: s.workspaces.map((w) => (w.name === "Zed" ? { ...w, order: 0 } : w)),
    };
    expect(sortedWorkspaces(s).map((w) => w.name)).toEqual(["Zed", "Apple", "Banana"]);

    let s2 = addWorkspace(createEmptyState(), "W");
    s2 = addProject(s2, { workspaceId: wsId(s2, 0), name: "Cee", path: "/c" });
    s2 = addProject(s2, { workspaceId: wsId(s2, 0), name: "Aye", path: "/a" });
    s2 = addProject(s2, { workspaceId: wsId(s2, 0), name: "Bee", path: "/b" });
    expect(sortedProjects(s2.workspaces[0]).map((p) => p.name)).toEqual(["Aye", "Bee", "Cee"]);
  });

  it("moveProject across workspaces preserves the project id and clears explicit order", () => {
    let s = createEmptyState();
    s = addWorkspace(s, "From");
    s = addWorkspace(s, "To");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
    const pid = projectId(s, 0, 0);
    s = moveProject(s, pid, wsId(s, 1), 0);
    expect(s.workspaces[0].projects).toEqual([]);
    expect(s.workspaces[1].projects[0].id).toBe(pid);
  });

  it("moveProject intra-workspace reorders and reassigns the order field", () => {
    let s = addWorkspace(createEmptyState(), "W");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "A", path: "/a" });
    s = addProject(s, { workspaceId: wsId(s, 0), name: "B", path: "/b" });
    s = addProject(s, { workspaceId: wsId(s, 0), name: "C", path: "/c" });
    const c = projectId(s, 0, 2);
    s = moveProject(s, c, wsId(s, 0), 0);
    expect(s.workspaces[0].projects.map((p) => p.name)).toEqual(["C", "A", "B"]);
    expect(s.workspaces[0].projects.every((p) => typeof p.order === "number")).toBe(true);
  });

  it("reorderProjects applies an explicit ordering and assigns order indexes", () => {
    let s = addWorkspace(createEmptyState(), "W");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "A", path: "/a" });
    s = addProject(s, { workspaceId: wsId(s, 0), name: "B", path: "/b" });
    const ws = wsId(s, 0);
    const a = projectId(s, 0, 0);
    const b = projectId(s, 0, 1);
    s = reorderProjects(s, ws, [b, a]);
    expect(s.workspaces[0].projects.map((p) => p.name)).toEqual(["B", "A"]);
    expect(s.workspaces[0].projects.map((p) => p.order)).toEqual([0, 1]);
  });

  it("reorderWorkspaces applies an explicit ordering and assigns order indexes", () => {
    let s = createEmptyState();
    s = addWorkspace(s, "A");
    s = addWorkspace(s, "B");
    const a = wsId(s, 0);
    const b = wsId(s, 1);
    s = reorderWorkspaces(s, [b, a]);
    expect(s.workspaces.map((w) => w.name)).toEqual(["B", "A"]);
    expect(s.workspaces.map((w) => w.order)).toEqual([0, 1]);
  });

  it("resetAlphabeticalOrder clears the order field of projects in a workspace", () => {
    let s = addWorkspace(createEmptyState(), "W");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "A", path: "/a" });
    s = addProject(s, { workspaceId: wsId(s, 0), name: "B", path: "/b" });
    s = reorderProjects(s, wsId(s, 0), [projectId(s, 0, 1), projectId(s, 0, 0)]);
    s = resetAlphabeticalOrder(s, wsId(s, 0));
    expect(s.workspaces[0].projects.every((p) => p.order === undefined)).toBe(true);
  });

  // ---------------------------------------------------------------------
  // F2 helpers
  // ---------------------------------------------------------------------

  function seededProject(): {
    state: ReturnType<typeof createEmptyState>;
    pid: ProjectId;
  } {
    let s = addWorkspace(createEmptyState(), "W");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p", path: "/p" });
    return { state: s, pid: projectId(s, 0, 0) };
  }

  function spec(id: string, overrides: Partial<TerminalSpec> = {}): TerminalSpec {
    return { id, ...overrides };
  }

  it("addTerminalSpec appends specs and preserves prior order", () => {
    const { state, pid } = seededProject();
    let s = addTerminalSpec(state, pid, spec("t1", { title: "First" }));
    s = addTerminalSpec(s, pid, spec("t2", { startupCmd: "ls" }));
    const p = findProject(s, pid)!.project;
    expect(p.terminals).toEqual([
      { id: "t1", title: "First" },
      { id: "t2", startupCmd: "ls" },
    ]);
  });

  it("addTerminalSpec is a no-op when the project does not exist", () => {
    const { state } = seededProject();
    const ghost = "ghost-id" as ProjectId;
    const next = addTerminalSpec(state, ghost, spec("t1"));
    // No mutation reaches a project => identity preserved at the project level.
    expect(next.workspaces[0].projects[0].terminals).toBeUndefined();
  });

  it("removeTerminalSpec drops the matching spec and is a no-op when missing", () => {
    const { state, pid } = seededProject();
    let s = addTerminalSpec(state, pid, spec("t1"));
    s = addTerminalSpec(s, pid, spec("t2"));
    s = removeTerminalSpec(s, pid, "t1");
    expect(findProject(s, pid)!.project.terminals).toEqual([{ id: "t2" }]);

    // Missing id: project is returned by identity (no terminals array change).
    const prevProject = findProject(s, pid)!.project;
    const next = removeTerminalSpec(s, pid, "does-not-exist");
    expect(findProject(next, pid)!.project).toBe(prevProject);
  });

  it("removeTerminalSpec on a project with no terminals is a no-op", () => {
    const { state, pid } = seededProject();
    const next = removeTerminalSpec(state, pid, "anything");
    expect(findProject(next, pid)!.project.terminals).toBeUndefined();
  });

  it("updateTerminalSpec patches partial fields and never changes the id", () => {
    const { state, pid } = seededProject();
    let s = addTerminalSpec(state, pid, spec("t1", { title: "Old", cwd: "/a" }));
    s = updateTerminalSpec(s, pid, "t1", { title: "New", startupCmd: "echo hi" });
    const updated = findProject(s, pid)!.project.terminals![0];
    expect(updated).toEqual({
      id: "t1",
      title: "New",
      cwd: "/a",
      startupCmd: "echo hi",
    });
  });

  it("updateTerminalSpec preserves identity when nothing changes", () => {
    const { state, pid } = seededProject();
    const s = addTerminalSpec(state, pid, spec("t1", { title: "Same" }));
    const beforeProject = findProject(s, pid)!.project;
    const next = updateTerminalSpec(s, pid, "t1", { title: "Same" });
    expect(findProject(next, pid)!.project).toBe(beforeProject);
  });

  it("updateTerminalSpec is a no-op when terminal or project is missing", () => {
    const { state, pid } = seededProject();
    const ghost = "ghost-id" as ProjectId;
    const a = updateTerminalSpec(state, pid, "missing", { title: "x" });
    expect(findProject(a, pid)!.project.terminals).toBeUndefined();
    const b = updateTerminalSpec(state, ghost, "any", { title: "x" });
    expect(findProject(b, pid)!.project.terminals).toBeUndefined();
  });

  it("replaceTerminalSpecs swaps the full list in one shot", () => {
    const { state, pid } = seededProject();
    let s = addTerminalSpec(state, pid, spec("t1"));
    s = replaceTerminalSpecs(s, pid, [spec("a"), spec("b"), spec("c")]);
    expect(findProject(s, pid)!.project.terminals).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });

  it("setActiveProject ignores unknown ids and accepts null", () => {
    let s = addWorkspace(createEmptyState(), "W");
    s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
    const pid = projectId(s, 0, 0);
    const ghost = "ghost-id" as ProjectId;
    expect(setActiveProject(s, ghost).activeProjectId).toBeNull();
    expect(setActiveProject(s, pid).activeProjectId).toBe(pid);
    expect(setActiveProject(setActiveProject(s, pid), null).activeProjectId).toBeNull();
  });
});

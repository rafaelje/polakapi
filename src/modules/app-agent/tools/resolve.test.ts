import { describe, expect, it } from "vitest";

import {
  addFolder,
  addProject,
  addWorkspace,
  createEmptyState,
  setActiveProject,
} from "../../workspaces/state/workspaces-reducer";
import type { WorkspacesState } from "../../workspaces/state/types";
import { findFolderByRef, findProjectByRef, findWorkspaceByRef, resolveProject } from "./resolve";
import { ToolError } from "./types";

function fixture(): WorkspacesState {
  let state = addWorkspace(createEmptyState(), "Work");
  state = addWorkspace(state, "Play");
  const [work, play] = state.workspaces;
  state = addProject(state, { workspaceId: work.id, name: "api", path: "/srv/api" });
  state = addProject(state, { workspaceId: work.id, name: "web", path: "/srv/web/" });
  state = addProject(state, { workspaceId: play.id, name: "api", path: "/home/me/api" });
  state = addFolder(state, work.id, "backend");
  return state;
}

describe("findProjectByRef", () => {
  it("matches by id, then by path", () => {
    const state = fixture();
    const web = state.workspaces[0].projects[1];
    expect(findProjectByRef(state, web.id).project).toBe(web);
    expect(findProjectByRef(state, "/srv/web").project).toBe(web);
    expect(findProjectByRef(state, "/SRV/WEB/").project).toBe(web);
  });

  it("matches unique names case-insensitively", () => {
    const state = fixture();
    expect(findProjectByRef(state, "WEB").project.path).toBe("/srv/web/");
  });

  it("refuses ambiguous names and lists candidates", () => {
    const state = fixture();
    expect(() => findProjectByRef(state, "api")).toThrow(/ambiguous/);
    expect(() => findProjectByRef(state, "api")).toThrow(/Work/);
  });

  it("reports unknown references as ToolError", () => {
    expect(() => findProjectByRef(fixture(), "nope")).toThrow(ToolError);
  });
});

describe("resolveProject", () => {
  it("falls back to the active project", () => {
    let state = fixture();
    const web = state.workspaces[0].projects[1];
    state = setActiveProject(state, web.id);
    expect(resolveProject(state, {}).project.id).toBe(web.id);
    expect(resolveProject(state, { project: "/srv/api" }).project.name).toBe("api");
  });

  it("asks for a project when none is active", () => {
    expect(() => resolveProject(fixture(), {})).toThrow(/no active project/);
  });
});

describe("workspace and folder lookups", () => {
  it("find workspaces by id or name", () => {
    const state = fixture();
    const play = state.workspaces[1];
    expect(findWorkspaceByRef(state, play.id)).toBe(play);
    expect(findWorkspaceByRef(state, "play")).toBe(play);
    expect(() => findWorkspaceByRef(state, "none")).toThrow(ToolError);
  });

  it("find folders inside a workspace", () => {
    const state = fixture();
    const work = state.workspaces[0];
    expect(findFolderByRef(work, "Backend").name).toBe("backend");
    expect(() => findFolderByRef(state.workspaces[1], "backend")).toThrow(/no folder/);
  });
});

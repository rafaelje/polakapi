import { describe, expect, it } from "vitest";

import type { ProjectId, WorkspaceId, WorkspacesState } from "./types";
import { addProject, addWorkspace, createEmptyState, findProject } from "./workspaces-reducer";
import {
  findShortcutTarget,
  normalizeShortcutKey,
  setProjectShortcut,
  setWorkspaceShortcut,
} from "./workspaces-reducer-shortcuts";

function seed(): WorkspacesState {
  let s = addWorkspace(createEmptyState(), "W1");
  s = addWorkspace(s, "W2");
  s = addProject(s, { workspaceId: s.workspaces[0].id, name: "p1", path: "/p1" });
  s = addProject(s, { workspaceId: s.workspaces[1].id, name: "p2", path: "/p2" });
  return s;
}

function pidAt(s: WorkspacesState, w: number, p: number): ProjectId {
  return s.workspaces[w].projects[p].id;
}

function wsIdAt(s: WorkspacesState, w: number): WorkspaceId {
  return s.workspaces[w].id;
}

describe("normalizeShortcutKey", () => {
  it("lowercases and accepts a single letter or digit", () => {
    expect(normalizeShortcutKey(" K ")).toBe("k");
    expect(normalizeShortcutKey("7")).toBe("7");
  });

  it("rejects empty, multi-char and symbol input", () => {
    expect(normalizeShortcutKey("")).toBeNull();
    expect(normalizeShortcutKey("ab")).toBeNull();
    expect(normalizeShortcutKey("[")).toBeNull();
  });
});

describe("setProjectShortcut / setWorkspaceShortcut", () => {
  it("assigns and clears a project shortcut", () => {
    let s = seed();
    const pid = pidAt(s, 0, 0);
    s = setProjectShortcut(s, pid, "a");
    expect(findProject(s, pid)?.project.shortcut).toBe("a");
    s = setProjectShortcut(s, pid, undefined);
    expect(findProject(s, pid)?.project.shortcut).toBeUndefined();
  });

  it("steals the key from the previous holder (project → project)", () => {
    let s = seed();
    const p1 = pidAt(s, 0, 0);
    const p2 = pidAt(s, 1, 0);
    s = setProjectShortcut(s, p1, "a");
    s = setProjectShortcut(s, p2, "a");
    expect(findProject(s, p1)?.project.shortcut).toBeUndefined();
    expect(findProject(s, p2)?.project.shortcut).toBe("a");
  });

  it("steals the key across kinds (workspace → project and back)", () => {
    let s = seed();
    const p1 = pidAt(s, 0, 0);
    s = setWorkspaceShortcut(s, wsIdAt(s, 0), "x");
    s = setProjectShortcut(s, p1, "x");
    expect(s.workspaces[0].shortcut).toBeUndefined();
    expect(findProject(s, p1)?.project.shortcut).toBe("x");
    s = setWorkspaceShortcut(s, wsIdAt(s, 1), "x");
    expect(findProject(s, p1)?.project.shortcut).toBeUndefined();
    expect(s.workspaces[1].shortcut).toBe("x");
  });

  it("is identity-preserving when nothing changes", () => {
    let s = seed();
    s = setProjectShortcut(s, pidAt(s, 0, 0), "a");
    expect(setProjectShortcut(s, pidAt(s, 0, 0), "a")).toBe(s);
    expect(setProjectShortcut(s, "ghost" as ProjectId, undefined)).toBe(s);
  });
});

describe("findShortcutTarget", () => {
  it("resolves projects before workspaces and returns null for unbound keys", () => {
    let s = seed();
    const p1 = pidAt(s, 0, 0);
    s = setProjectShortcut(s, p1, "a");
    s = setWorkspaceShortcut(s, wsIdAt(s, 1), "b");
    expect(findShortcutTarget(s, "a")).toEqual({ kind: "project", projectId: p1 });
    expect(findShortcutTarget(s, "b")).toEqual({ kind: "workspace", workspaceId: wsIdAt(s, 1) });
    expect(findShortcutTarget(s, "z")).toBeNull();
  });
});

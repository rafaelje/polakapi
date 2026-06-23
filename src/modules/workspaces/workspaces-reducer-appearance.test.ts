import { describe, expect, it } from "vitest";

import type { ColorToken, ProjectId, WorkspaceId } from "./types";
import {
  PALETTE,
  addProject,
  addWorkspace,
  createEmptyState,
  deriveFallbackColor,
  findProject,
  setProjectColor,
  setWorkspaceColor,
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

function seedTwoWorkspacesTwoProjects() {
  let s = addWorkspace(createEmptyState(), "W1");
  s = addWorkspace(s, "W2");
  s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
  s = addProject(s, { workspaceId: wsId(s, 0), name: "p2", path: "/p2" });
  s = addProject(s, { workspaceId: wsId(s, 1), name: "p3", path: "/p3" });
  return s;
}

describe("PALETTE", () => {
  it("has exactly 6 tokens", () => {
    expect(PALETTE).toHaveLength(6);
  });

  it("contains the documented set", () => {
    expect([...PALETTE]).toEqual(["slate", "blue", "purple", "pink", "green", "orange"]);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(PALETTE)).toBe(true);
  });
});

describe("setWorkspaceColor", () => {
  it("writes the color onto the matching workspace", () => {
    let s = addWorkspace(createEmptyState(), "W");
    const id = wsId(s, 0);
    s = setWorkspaceColor(s, id, "blue");
    expect(s.workspaces[0].color).toBe("blue");
  });

  it("clears the field when value is undefined", () => {
    let s = addWorkspace(createEmptyState(), "W");
    const id = wsId(s, 0);
    s = setWorkspaceColor(s, id, "blue");
    expect(s.workspaces[0].color).toBe("blue");
    s = setWorkspaceColor(s, id, undefined);
    expect(s.workspaces[0].color).toBeUndefined();
    expect("color" in s.workspaces[0]).toBe(false);
  });

  it("returns the same state reference when value is unchanged", () => {
    let s = addWorkspace(createEmptyState(), "W");
    const id = wsId(s, 0);
    s = setWorkspaceColor(s, id, "green");
    const next = setWorkspaceColor(s, id, "green");
    expect(next).toBe(s);
  });

  it("returns the same state reference when the workspace does not exist", () => {
    const s = addWorkspace(createEmptyState(), "W");
    const ghost = "ghost-ws" as WorkspaceId;
    const next = setWorkspaceColor(s, ghost, "blue");
    expect(next).toBe(s);
  });

  it("does not affect other workspaces", () => {
    const s = seedTwoWorkspacesTwoProjects();
    const w1 = wsId(s, 0);
    const w2Before = s.workspaces[1];
    const next = setWorkspaceColor(s, w1, "purple");
    expect(next.workspaces[0].color).toBe("purple");
    expect(next.workspaces[1]).toBe(w2Before);
  });
});

describe("setProjectColor", () => {
  it("writes the color onto the matching project", () => {
    const s0 = seedTwoWorkspacesTwoProjects();
    const pid = projectIdAt(s0, 0, 0);
    const s = setProjectColor(s0, pid, "pink");
    expect(findProject(s, pid)?.project.color).toBe("pink");
  });

  it("clears the field when value is undefined", () => {
    let s = seedTwoWorkspacesTwoProjects();
    const pid = projectIdAt(s, 0, 0);
    s = setProjectColor(s, pid, "pink");
    s = setProjectColor(s, pid, undefined);
    const project = findProject(s, pid)!.project;
    expect(project.color).toBeUndefined();
    expect("color" in project).toBe(false);
  });

  it("returns the same state reference when value is unchanged", () => {
    let s = seedTwoWorkspacesTwoProjects();
    const pid = projectIdAt(s, 0, 0);
    s = setProjectColor(s, pid, "orange");
    const next = setProjectColor(s, pid, "orange");
    expect(next).toBe(s);
  });

  it("returns the same state reference when the project does not exist", () => {
    const s = seedTwoWorkspacesTwoProjects();
    const ghost = "ghost-pid" as ProjectId;
    const next = setProjectColor(s, ghost, "blue");
    expect(next).toBe(s);
  });

  it("does not affect other projects or workspaces", () => {
    const s = seedTwoWorkspacesTwoProjects();
    const p1 = projectIdAt(s, 0, 0);
    const p2Before = findProject(s, projectIdAt(s, 0, 1))!.project;
    const w2Before = s.workspaces[1];
    const next = setProjectColor(s, p1, "slate");
    expect(findProject(next, p1)?.project.color).toBe("slate");
    expect(findProject(next, projectIdAt(s, 0, 1))!.project).toBe(p2Before);
    expect(next.workspaces[1]).toBe(w2Before);
  });
});

describe("deriveFallbackColor", () => {
  it("returns a token from PALETTE", () => {
    const token: ColorToken = deriveFallbackColor("any-id");
    expect(PALETTE).toContain(token);
  });

  it("is deterministic — same input maps to same token", () => {
    const a = deriveFallbackColor("project-123");
    const b = deriveFallbackColor("project-123");
    expect(a).toBe(b);
  });

  it("covers every palette slot across a small sample of ids", () => {
    const seen = new Set<ColorToken>();
    for (let i = 0; i < 200; i++) seen.add(deriveFallbackColor(`id-${i}`));
    // With 200 samples mod 6 the surjection is practically guaranteed —
    // serves as a smoke check that the hash actually spreads.
    expect(seen.size).toBe(PALETTE.length);
  });

  it("handles the empty string without throwing", () => {
    expect(() => deriveFallbackColor("")).not.toThrow();
    expect(PALETTE).toContain(deriveFallbackColor(""));
  });
});

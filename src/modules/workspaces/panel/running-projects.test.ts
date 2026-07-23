import { describe, expect, it } from "vitest";

import type { ProjectId } from "../state/types";
import { addProject, addWorkspace, createEmptyState } from "../state/workspaces-reducer";
import { collectRunningProjects } from "./running-projects";

function seed() {
  let s = addWorkspace(createEmptyState(), "W1");
  s = addWorkspace(s, "W2");
  s = addProject(s, { workspaceId: s.workspaces[0].id, name: "alpha", path: "/a" });
  s = addProject(s, { workspaceId: s.workspaces[0].id, name: "beta", path: "/b" });
  s = addProject(s, { workspaceId: s.workspaces[1].id, name: "gamma", path: "/g" });
  const id = (w: number, p: number): ProjectId => s.workspaces[w].projects[p].id;
  return { s, id };
}

describe("collectRunningProjects", () => {
  it("includes only projects with a live count > 0, in sidebar order", () => {
    const { s, id } = seed();
    const counts = new Map<ProjectId, number>([
      [id(0, 1), 2],
      [id(1, 0), 1],
    ]);
    const running = collectRunningProjects(s, (pid) => counts.get(pid) ?? 0);
    expect(running.map((e) => e.project.name)).toEqual(["beta", "gamma"]);
    expect(running.map((e) => e.workspaceName)).toEqual(["W1", "W2"]);
    expect(running.map((e) => e.count)).toEqual([2, 1]);
  });

  it("returns an empty list when nothing is running", () => {
    const { s } = seed();
    expect(collectRunningProjects(s, () => 0)).toEqual([]);
  });
});

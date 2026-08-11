import { describe, expect, it } from "vitest";

import type { ProjectId, TerminalSpec, WorkspaceId } from "./types";
import {
  addProject,
  addTerminalSpec,
  addWorkspace,
  createEmptyState,
  findProject,
  replaceTerminalSpecs,
  setProjectActiveCli,
  setProjectTerminalLayout,
  updateTerminalSpec,
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

function seed(): { state: ReturnType<typeof createEmptyState>; pid: ProjectId } {
  let s = addWorkspace(createEmptyState(), "W");
  s = addProject(s, { workspaceId: wsId(s, 0), name: "p1", path: "/p1" });
  return { state: s, pid: projectIdAt(s, 0, 0) };
}

describe("updateTerminalSpec with cliId", () => {
  it("patches cliId on the matching spec", () => {
    const seeded = seed();
    const pid = seeded.pid;
    let state = seeded.state;
    const spec: TerminalSpec = { id: "t1", cliId: "shell" };
    state = addTerminalSpec(state, pid, spec);
    state = updateTerminalSpec(state, pid, "t1", { cliId: "claude" });
    const terminals = findProject(state, pid)?.project.terminals;
    expect(terminals?.[0].cliId).toBe("claude");
  });

  it("preserves the project reference when cliId is unchanged", () => {
    const seeded = seed();
    const pid = seeded.pid;
    let state = seeded.state;
    state = addTerminalSpec(state, pid, { id: "t1", cliId: "claude" });
    const before = findProject(state, pid)!.project;
    state = updateTerminalSpec(state, pid, "t1", { cliId: "claude" });
    expect(findProject(state, pid)!.project).toBe(before);
  });

  it("detects a change when cliId differs (no other fields changed)", () => {
    const seeded = seed();
    const pid = seeded.pid;
    let state = seeded.state;
    state = addTerminalSpec(state, pid, { id: "t1", title: "tt", cliId: "shell" });
    const next = updateTerminalSpec(state, pid, "t1", { cliId: "codex" });
    expect(next).not.toBe(state);
    const terminals = findProject(next, pid)?.project.terminals;
    expect(terminals?.[0]).toEqual({ id: "t1", title: "tt", cliId: "codex" });
  });

  it("detects a change when cliId moves from undefined to a value", () => {
    const seeded = seed();
    const pid = seeded.pid;
    let state = seeded.state;
    state = addTerminalSpec(state, pid, { id: "t1" });
    const next = updateTerminalSpec(state, pid, "t1", { cliId: "claude" });
    expect(next).not.toBe(state);
    expect(findProject(next, pid)?.project.terminals?.[0].cliId).toBe("claude");
  });

  it("treats undefined cliId patch as identity when current cliId is undefined", () => {
    const seeded = seed();
    const pid = seeded.pid;
    let state = seeded.state;
    state = addTerminalSpec(state, pid, { id: "t1" });
    const before = findProject(state, pid)!.project;
    state = updateTerminalSpec(state, pid, "t1", { cliId: undefined });
    expect(findProject(state, pid)!.project).toBe(before);
  });
});

describe("setProjectActiveCli", () => {
  it("sets the activeCliId on the project", () => {
    const { state, pid } = seed();
    const next = setProjectActiveCli(state, pid, "claude");
    expect(findProject(next, pid)?.project.activeCliId).toBe("claude");
  });

  it("clears the field when set back to shell (default)", () => {
    const seeded = seed();
    const pid = seeded.pid;
    let state = seeded.state;
    state = setProjectActiveCli(state, pid, "claude");
    state = setProjectActiveCli(state, pid, "shell");
    expect(findProject(state, pid)?.project.activeCliId).toBeUndefined();
  });

  it("preserves project identity when value does not change", () => {
    const { state, pid } = seed();
    const before = findProject(state, pid)!.project;
    const next = setProjectActiveCli(state, pid, "shell");
    expect(findProject(next, pid)!.project).toBe(before);
  });
});

describe("addTerminalSpec / replaceTerminalSpecs preserve cliId", () => {
  it("addTerminalSpec carries cliId through", () => {
    const seeded = seed();
    const pid = seeded.pid;
    let state = seeded.state;
    state = addTerminalSpec(state, pid, { id: "t1", cliId: "opencode" });
    expect(findProject(state, pid)?.project.terminals?.[0].cliId).toBe("opencode");
  });

  it("replaceTerminalSpecs preserves cliId on each spec", () => {
    const seeded = seed();
    const pid = seeded.pid;
    let state = seeded.state;
    const specs: TerminalSpec[] = [
      { id: "a", cliId: "shell" },
      { id: "b", cliId: "claude" },
      { id: "c" },
    ];
    state = replaceTerminalSpecs(state, pid, specs);
    const terminals = findProject(state, pid)?.project.terminals;
    expect(terminals?.[0].cliId).toBe("shell");
    expect(terminals?.[1].cliId).toBe("claude");
    expect(terminals?.[2].cliId).toBeUndefined();
  });
});
describe("setProjectTerminalLayout", () => {
  it("stores and clears a project layout", () => {
    const { state, pid } = seed();
    const layout = {
      type: "split" as const,
      axis: "column" as const,
      ratio: 0.6,
      first: { type: "pane" as const, paneId: "a" },
      second: { type: "pane" as const, paneId: "b" },
    };

    const stored = setProjectTerminalLayout(state, pid, layout);
    expect(findProject(stored, pid)?.project.terminalLayout).toEqual(layout);
    const cleared = setProjectTerminalLayout(stored, pid, null);
    expect(findProject(cleared, pid)?.project.terminalLayout).toBeUndefined();
  });

  it("preserves project identity for an equivalent layout", () => {
    const { state, pid } = seed();
    const layout = { type: "pane" as const, paneId: "a" };
    const stored = setProjectTerminalLayout(state, pid, layout);
    const project = findProject(stored, pid)!.project;

    const unchanged = setProjectTerminalLayout(stored, pid, { ...layout });

    expect(findProject(unchanged, pid)!.project).toBe(project);
  });
});

describe("terminal launch arguments", () => {
  it("persists launch arguments and compares equal arrays by value", () => {
    const { state, pid } = seed();
    const withTerminal = addTerminalSpec(state, pid, {
      id: "resume",
      cliId: "codex",
      launchArgs: ["resume", "session-1"],
    });

    const unchanged = updateTerminalSpec(withTerminal, pid, "resume", {
      launchArgs: ["resume", "session-1"],
    });
    const changed = updateTerminalSpec(withTerminal, pid, "resume", {
      launchArgs: ["resume", "session-2"],
    });

    expect(findProject(unchanged, pid)?.project).toBe(findProject(withTerminal, pid)?.project);
    expect(findProject(changed, pid)?.project.terminals?.[0]?.launchArgs).toEqual([
      "resume",
      "session-2",
    ]);
  });
});

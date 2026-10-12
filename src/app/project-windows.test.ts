import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  return {
    handlers,
    fire(name: string, payload: unknown): void {
      handlers.get(name)?.({ payload });
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, handler);
    return Promise.resolve(() => events.handlers.delete(name));
  }),
  emitTo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../shared/tauri/invoke", () => ({ invoke: vi.fn() }));

import { emitTo } from "@tauri-apps/api/event";
import { invoke } from "../shared/tauri/invoke";
import type { Project, ProjectId } from "../modules/workspaces/state/types";
import { createProjectWindows, type ProjectWindowsDeps } from "./project-windows";
import type { ReleasedGrid } from "./terminal-router";

const project: Project = { id: "p1" as ProjectId, name: "ice-games", path: "/repos/ice" };
const SNAPSHOT = { screen: "\u001b[31mred", offset: 42, cols: 80, rows: 24 };
const grid: ReleasedGrid = {
  specs: [{ id: "pty-a" }, { id: "old", suspended: true }],
  layout: { type: "pane", paneId: "pty-a" },
  activeCliId: "claude",
};

function router() {
  return {
    release: vi.fn().mockResolvedValue(structuredClone(grid)),
    adopt: vi.fn().mockResolvedValue(undefined),
    tearOff: vi.fn().mockResolvedValue({
      spec: { id: "pty-b", cliId: "codex", title: "api" },
      snapshot: SNAPSHOT,
    }),
    adoptPanes: vi.fn().mockResolvedValue(true),
    setExternalCount: vi.fn(),
    setExternalSpecs: vi.fn(),
    setExternalLayout: vi.fn(),
  };
}

async function setup() {
  const fakeRouter = router();
  const deps = {
    router: fakeRouter as unknown as ProjectWindowsDeps["router"],
    findProject: vi.fn().mockReturnValue(project),
    persistSpecs: vi.fn(),
    persistLayout: vi.fn(),
    onBell: vi.fn(),
    onReturned: vi.fn(),
  };
  const windows = await createProjectWindows(deps);
  return { windows, deps, fakeRouter };
}

const opened = (): Array<{ windowId: string; payload: unknown; position?: unknown }> =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "project_window_open")
    .map(([, args]) => (args as { state: never }).state);

beforeEach(() => {
  vi.clearAllMocks();
  events.handlers.clear();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe("a project's whole grid in its own window", () => {
  it("hands the grid over without stopping any process", async () => {
    const { windows, fakeRouter } = await setup();
    await windows.detach(project);

    expect(fakeRouter.release).toHaveBeenCalledWith(project.id);
    expect(opened()[0]).toMatchObject({
      windowId: "p1",
      projectId: "p1",
      title: "ice-games",
      payload: { path: "/repos/ice", ...grid },
    });
    // Only the live pane counts; the suspended one has no process.
    expect(fakeRouter.setExternalCount).toHaveBeenCalledWith("p1", project.id, 1);
    expect(windows.isDetached(project.id)).toBe(true);
  });

  it("puts the grid straight back when the window fails to open", async () => {
    const { windows, deps, fakeRouter } = await setup();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("no display"));

    await expect(windows.detach(project)).rejects.toThrow("no display");

    expect(fakeRouter.adopt).toHaveBeenCalledWith(project, grid);
    expect(deps.onReturned).toHaveBeenCalledWith(project.id);
    expect(windows.isDetached(project.id)).toBe(false);
  });

  it("persists what the window reports and brings it back on close", async () => {
    const { windows, deps, fakeRouter } = await setup();
    await windows.detach(project);

    const specs = [{ id: "pty-a" }, { id: "pty-b" }];
    const layout = { type: "pane" as const, paneId: "pty-b" };
    events.fire("project-window:update", {
      windowId: "p1",
      projectId: "p1",
      specs,
      layout,
      liveCount: 2,
    });
    events.fire("project-window:update", {
      windowId: "p1",
      projectId: "p1",
      bell: { paneId: "pty-b", pending: true },
    });

    expect(fakeRouter.setExternalSpecs).toHaveBeenCalledWith("p1", project.id, specs);
    expect(fakeRouter.setExternalLayout).toHaveBeenCalledWith("p1", project.id, layout);
    expect(fakeRouter.setExternalCount).toHaveBeenLastCalledWith("p1", project.id, 2);
    expect(deps.onBell).toHaveBeenCalledWith(project.id, "pty-b", true);

    events.fire("project-window:closed", { windowId: "p1" });
    await vi.waitFor(() => expect(fakeRouter.adopt).toHaveBeenCalled());
    expect(fakeRouter.adopt).toHaveBeenCalledWith(project, {
      specs,
      layout,
      activeCliId: "claude",
    });
    expect(fakeRouter.setExternalCount).toHaveBeenLastCalledWith("p1", project.id, null);
    expect(windows.isDetached(project.id)).toBe(false);
  });

  it("ignores windows it did not open", async () => {
    const { deps } = await setup();
    events.fire("project-window:update", { windowId: "x", projectId: "x", liveCount: 9 });
    events.fire("project-window:closed", { windowId: "x" });
    expect(deps.persistSpecs).not.toHaveBeenCalled();
    expect(deps.onReturned).not.toHaveBeenCalled();
  });

  it("brings back by closing the window, and focuses instead of opening twice", async () => {
    const { windows } = await setup();
    await windows.detach(project);
    vi.mocked(invoke).mockClear();

    await windows.detach(project);
    expect(invoke).toHaveBeenCalledWith("project_window_focus", { windowId: "p1" });

    await windows.bringBack(project.id);
    expect(invoke).toHaveBeenCalledWith(
      "project_window_close",
      { windowId: "p1" },
      expect.anything(),
    );
  });
});

describe("a terminal dragged out of the grid", () => {
  it("opens that one terminal where it was dropped, process still running", async () => {
    const { windows, fakeRouter } = await setup();
    await windows.tearOff(project, "pty-b", { x: 900, y: 300 });

    expect(fakeRouter.tearOff).toHaveBeenCalledWith(project.id, "pty-b");
    expect(opened()[0]).toMatchObject({
      windowId: "p1--pty-b",
      title: "ice-games · api",
      position: [900, 300],
      payload: {
        specs: [{ id: "pty-b", cliId: "codex", title: "api" }],
        layout: { type: "pane", paneId: "pty-b" },
        activeCliId: "codex",
      },
    });
    expect(fakeRouter.setExternalCount).toHaveBeenCalledWith("p1--pty-b", project.id, 1);
    // One terminal out is not the whole project out.
    expect(windows.isDetached(project.id)).toBe(false);
  });

  it("never overwrites the project's saved terminals with the lone pane", async () => {
    const { windows, deps, fakeRouter } = await setup();
    await windows.tearOff(project, "pty-b");
    events.fire("project-window:update", {
      windowId: "p1--pty-b",
      projectId: "p1",
      specs: [{ id: "pty-b" }],
      layout: { type: "pane", paneId: "pty-b" },
    });
    expect(deps.persistSpecs).not.toHaveBeenCalled();
    expect(deps.persistLayout).not.toHaveBeenCalled();
    expect(fakeRouter.setExternalSpecs).toHaveBeenLastCalledWith("p1--pty-b", project.id, [
      { id: "pty-b" },
    ]);
  });

  it("goes back into the project's grid when its window closes", async () => {
    const { windows, fakeRouter } = await setup();
    await windows.tearOff(project, "pty-b");

    events.fire("project-window:closed", { windowId: "p1--pty-b" });

    await vi.waitFor(() => expect(fakeRouter.adoptPanes).toHaveBeenCalled());
    expect(fakeRouter.adoptPanes).toHaveBeenCalledWith(
      project.id,
      [{ id: "pty-b", cliId: "codex", title: "api" }],
      { "pty-b": SNAPSHOT },
    );
    expect(fakeRouter.setExternalCount).toHaveBeenLastCalledWith("p1--pty-b", project.id, null);
  });

  it("goes to the project's window when the whole grid is out", async () => {
    const { windows, fakeRouter } = await setup();
    await windows.tearOff(project, "pty-b");
    await windows.detach(project);

    events.fire("project-window:closed", { windowId: "p1--pty-b" });

    await vi.waitFor(() => expect(emitTo).toHaveBeenCalled());
    expect(emitTo).toHaveBeenCalledWith("project-p1", "project-window:adopt", {
      adoptionId: expect.any(String) as string,
      spec: { id: "pty-b", cliId: "codex", title: "api" },
      snapshot: SNAPSHOT,
    });
    expect(fakeRouter.adoptPanes).not.toHaveBeenCalled();
  });

  it("retains every returning pane before waiting for transport to a closing target", async () => {
    const { windows, fakeRouter } = await setup();
    await windows.tearOff(project, "pty-b");
    await windows.detach(project);
    events.fire("project-window:update", {
      windowId: "p1--pty-b",
      projectId: "p1",
      specs: [{ id: "pty-b" }, { id: "pty-c" }],
      snapshots: { "pty-b": SNAPSHOT, "pty-c": { ...SNAPSHOT, screen: "final c", exited: true } },
    });
    let deliver!: () => void;
    vi.mocked(emitTo).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          deliver = resolve;
        }),
    );
    events.fire("project-window:closed", { windowId: "p1--pty-b" });
    await vi.waitFor(() => expect(emitTo).toHaveBeenCalled());
    events.fire("project-window:update", {
      windowId: "p1",
      projectId: "p1",
      closing: true,
      specs: [{ id: "pty-a" }],
      snapshots: {},
    });
    events.fire("project-window:closed", { windowId: "p1" });
    await vi.waitFor(() => expect(fakeRouter.adopt).toHaveBeenCalled());
    deliver();
    expect(fakeRouter.adopt.mock.lastCall?.[1]).toMatchObject({
      specs: [{ id: "pty-a" }, { id: "pty-b" }, { id: "pty-c" }],
      snapshots: { "pty-b": SNAPSHOT, "pty-c": { screen: "final c", exited: true } },
    });
  });

  it("keeps ownership and clears the torn source even when adoption transport rejects", async () => {
    const { windows, fakeRouter } = await setup();
    await windows.tearOff(project, "pty-b");
    await windows.detach(project);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(emitTo).mockRejectedValueOnce(new Error("target is closing"));
    events.fire("project-window:closed", { windowId: "p1--pty-b" });
    await vi.waitFor(() =>
      expect(fakeRouter.setExternalSpecs).toHaveBeenCalledWith("p1--pty-b", project.id, null),
    );
    events.fire("project-window:update", {
      windowId: "p1",
      projectId: "p1",
      specs: [{ id: "pty-a" }],
      snapshots: {},
    });
    events.fire("project-window:closed", { windowId: "p1" });
    await vi.waitFor(() => expect(fakeRouter.adopt).toHaveBeenCalled());
    expect(fakeRouter.adopt.mock.lastCall?.[1]).toMatchObject({
      specs: [{ id: "pty-a" }, { id: "pty-b" }],
      snapshots: { "pty-b": SNAPSHOT },
    });
    error.mockRestore();
  });

  it("does nothing for a terminal that is not in the grid", async () => {
    const { windows, fakeRouter } = await setup();
    fakeRouter.tearOff.mockResolvedValueOnce(null);
    await windows.tearOff(project, "gone");
    expect(opened()).toEqual([]);
  });
});

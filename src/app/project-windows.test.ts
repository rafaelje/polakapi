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
}));
vi.mock("../shared/tauri/invoke", () => ({ invoke: vi.fn() }));

import { invoke } from "../shared/tauri/invoke";
import type { Project, ProjectId } from "../modules/workspaces/state/types";
import { createProjectWindows, type ProjectWindowsDeps } from "./project-windows";
import type { ReleasedGrid } from "./terminal-router";

const project: Project = { id: "p1" as ProjectId, name: "ice-games", path: "/repos/ice" };
const grid: ReleasedGrid = {
  specs: [{ id: "pty-a" }, { id: "old", suspended: true }],
  layout: { type: "pane", paneId: "pty-a" },
  activeCliId: "claude",
};

function router() {
  return {
    release: vi.fn().mockResolvedValue(grid),
    adopt: vi.fn().mockResolvedValue(undefined),
    setExternalCount: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  events.handlers.clear();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe("project windows", () => {
  it("hands the grid to a new window without stopping any process", async () => {
    const { windows, fakeRouter } = await setup();
    await windows.detach(project);

    expect(fakeRouter.release).toHaveBeenCalledWith(project.id);
    expect(invoke).toHaveBeenCalledWith(
      "project_window_open",
      {
        state: {
          projectId: "p1",
          title: "ice-games",
          payload: { path: "/repos/ice", ...grid },
        },
      },
      expect.anything(),
    );
    // Only the live pane counts; the suspended one has no process.
    expect(fakeRouter.setExternalCount).toHaveBeenCalledWith(project.id, 1);
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

  it("persists what the window reports and keeps it for the return trip", async () => {
    const { windows, deps, fakeRouter } = await setup();
    await windows.detach(project);

    const specs = [{ id: "pty-a" }, { id: "pty-b" }];
    const layout = { type: "pane" as const, paneId: "pty-b" };
    events.fire("project-window:update", { projectId: "p1", specs, layout, liveCount: 2 });
    events.fire("project-window:update", {
      projectId: "p1",
      bell: { paneId: "pty-b", pending: true },
    });

    expect(deps.persistSpecs).toHaveBeenCalledWith(project.id, specs);
    expect(deps.persistLayout).toHaveBeenCalledWith(project.id, layout);
    expect(fakeRouter.setExternalCount).toHaveBeenLastCalledWith(project.id, 2);
    expect(deps.onBell).toHaveBeenCalledWith(project.id, "pty-b", true);

    events.fire("project-window:closed", { projectId: "p1" });
    await vi.waitFor(() => expect(fakeRouter.adopt).toHaveBeenCalled());
    expect(fakeRouter.adopt).toHaveBeenCalledWith(project, {
      specs,
      layout,
      activeCliId: "claude",
    });
    expect(fakeRouter.setExternalCount).toHaveBeenLastCalledWith(project.id, null);
    expect(deps.onReturned).toHaveBeenCalledWith(project.id);
    expect(windows.isDetached(project.id)).toBe(false);
  });

  it("ignores reports about projects it did not hand out", async () => {
    const { deps } = await setup();
    events.fire("project-window:update", { projectId: "someone-else", liveCount: 9 });
    events.fire("project-window:closed", { projectId: "someone-else" });
    expect(deps.persistSpecs).not.toHaveBeenCalled();
    expect(deps.onReturned).not.toHaveBeenCalled();
  });

  it("brings back by closing the window, and focuses instead of opening twice", async () => {
    const { windows } = await setup();
    await windows.detach(project);
    vi.mocked(invoke).mockClear();

    await windows.detach(project);
    expect(invoke).toHaveBeenCalledWith("project_window_focus", { projectId: "p1" });

    await windows.bringBack(project.id);
    expect(invoke).toHaveBeenCalledWith(
      "project_window_close",
      { projectId: "p1" },
      expect.anything(),
    );
  });
});

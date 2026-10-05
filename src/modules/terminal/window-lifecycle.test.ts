import { beforeEach, expect, it, vi } from "vitest";
import { terminalManagerFixture as fake } from "./terminal-manager.test-support";
import { TerminalRouter } from "../../app/terminal-router";
import { createProjectWindows } from "../../app/project-windows";
import type { TerminalSpec } from "./types";
import type { TerminalLayoutNode } from "./terminal-layout";
import type { Project, ProjectId } from "../workspaces/state/types";

const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    events.set(name, handler);
    return Promise.resolve(() => events.delete(name));
  }),
  emitTo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../shared/tauri/invoke", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("release drains a pane creation admitted before handoff", async () => {
  const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
  const manager = router.getOrCreate(project);
  const gate = deferred();
  fake.attachGate = gate.promise;
  const adding = manager.addPane({ title: "pending" });
  const releasing = router.release(project.id);
  gate.resolve();
  await adding;
  expect((await releasing)?.specs).toEqual([
    expect.objectContaining({ id: "pty-1", title: "pending" }),
  ]);
  expect(fake.disposeCalls).toContainEqual({ id: "pty-1", keepPty: true });
  expect(await manager.addPane()).toBeNull();
});

it("a close during a release snapshot cannot kill a transferred PTY", async () => {
  const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
  const manager = router.getOrCreate(project);
  await manager.addPane();
  const gate = deferred();
  const snapshot = vi.spyOn(manager.get("pty-1")!, "snapshot").mockImplementation(async () => {
    await gate.promise;
    return null;
  });
  const releasing = router.release(project.id);
  await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
  await manager.close("pty-1");
  gate.resolve();
  expect((await releasing)?.specs).toHaveLength(1);
  expect(fake.disposeCalls).not.toContainEqual({ id: "pty-1" });
});

it("deletion kills a late creation rather than adding it to a removed manager", async () => {
  const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
  const manager = router.getOrCreate(project);
  const gate = deferred();
  fake.attachGate = gate.promise;
  const adding = manager.addPane();
  const deleting = router.dispose(project.id);
  gate.resolve();
  await adding;
  await deleting;
  expect(manager.ids()).toEqual([]);
  expect(fake.disposeCalls).toContainEqual({ id: "pty-1" });
});

it("deletes whole and torn windows, kills their PTYs and ignores stale close events", async () => {
  const { invoke } = await import("../../shared/tauri/invoke");
  const { ptyKill } = await import("./pty-client");
  const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
  const manager = router.getOrCreate(project);
  await manager.addPane();
  await manager.addPane();
  const windows = await createProjectWindows({
    router,
    findProject: () => project,
    persistSpecs: vi.fn(),
    persistLayout: vi.fn(),
    onBell: vi.fn(),
    onReturned: vi.fn(),
  });
  await windows.tearOff(project, "pty-2");
  await windows.detach(project);
  await windows.deleteProject(project.id);
  expect(ptyKill).toHaveBeenCalledWith("pty-1");
  expect(ptyKill).toHaveBeenCalledWith("pty-2");
  expect(invoke).toHaveBeenCalledWith(
    "project_window_close",
    { windowId: "p1" },
    expect.anything(),
  );
  expect(invoke).toHaveBeenCalledWith(
    "project_window_close",
    { windowId: "p1--pty-2" },
    expect.anything(),
  );
  events.get("project-window:closed")?.({ payload: { windowId: "p1" } });
  await Promise.resolve();
  expect(router.getById(project.id)).toBeNull();
  expect(router.getCount(project.id)).toBe(0);
  windows.dispose();
});

it("includes detached ids in persistence layout while keeping the local layout intact", async () => {
  const { terminalLayoutPaneIds } = await import("./terminal-layout");
  const layout = vi.fn<(projectId: ProjectId, layout: TerminalLayoutNode | null) => void>();
  const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: layout });
  const manager = router.getOrCreate(project);
  await manager.addPane();
  await manager.addPane();
  await router.tearOff(project.id, "pty-2");
  expect(manager.layoutSnapshot).toEqual({ type: "pane", paneId: "pty-1" });
  expect(terminalLayoutPaneIds(layout.mock.lastCall?.[1] ?? null)).toEqual(["pty-1", "pty-2"]);
});

it("does not admit a new creation between an idle drain and snapshot freeze", async () => {
  const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
  const manager = router.getOrCreate(project);
  await manager.addPane();
  const releasing = router.release(project.id);
  const adding = manager.addPane();
  await releasing;
  await adding;
  expect(fake.attachCalls).toHaveLength(1);
});

it.each(["release", "tearOff"] as const)(
  "deletion invalidates a pending %s snapshot",
  async (action) => {
    const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
    const manager = router.getOrCreate(project);
    await manager.addPane();
    const gate = deferred();
    const snapshot = vi.spyOn(manager.get("pty-1")!, "snapshot").mockImplementation(async () => {
      await gate.promise;
      return null;
    });
    const transferring =
      action === "release" ? router.release(project.id) : router.tearOff(project.id, "pty-1");
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
    await router.dispose(project.id);
    gate.resolve();
    expect(await transferring).toBeNull();
    expect(router.getById(project.id)).toBeNull();
    expect(fake.disposeCalls).toContainEqual({ id: "pty-1" });
  },
);

it("adoption waits for an in-progress tear-off instead of silently losing the returned pane", async () => {
  const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
  const manager = router.getOrCreate(project);
  await manager.addPane();
  const gate = deferred();
  const snapshot = vi.spyOn(manager.get("pty-1")!, "snapshot").mockImplementation(async () => {
    await gate.promise;
    return null;
  });
  const transferring = router.tearOff(project.id, "pty-1");
  await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
  const adopting = router.adoptPanes(project.id, [{ id: "returned", title: "return" }]);
  gate.resolve();
  await transferring;
  await adopting;
  expect(manager.specs()).toEqual([expect.objectContaining({ id: "returned", title: "return" })]);
});

it("keeps exited and suspended configurations in the released and restored grid", async () => {
  const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
  const manager = router.getOrCreate(project);
  await manager.addPane({ title: "exited" });
  manager.markExited("pty-1");
  await manager.restoreSpecs([
    { id: "suspended", suspended: true, cwd: "/custom", launchArgs: ["--resume"] },
  ]);
  const grid = await router.release(project.id);
  expect(grid?.specs).toHaveLength(2);
  const returned = await router.adopt(project, grid!);
  expect(returned.specs()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "pty-1", title: "exited" }),
      expect.objectContaining({
        id: "suspended",
        suspended: true,
        cwd: "/custom",
        launchArgs: ["--resume"],
      }),
    ]),
  );
  await router.dispose(project.id);
});

const project: Project = { id: "p1" as ProjectId, name: "project", path: "/repo" };
it("waits for native creation before closing a project deleted during open", async () => {
  const { invoke } = await import("../../shared/tauri/invoke");
  const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
  await router.getOrCreate(project).addPane();
  const gate = deferred();
  const order: string[] = [];
  vi.mocked(invoke)
    .mockImplementationOnce(async () => {
      await gate.promise;
      order.push("opened");
      return undefined;
    })
    .mockImplementationOnce(() => {
      order.push("closed");
      return Promise.resolve(undefined);
    });
  const windows = await createProjectWindows({
    router,
    findProject: () => project,
    persistSpecs: vi.fn(),
    persistLayout: vi.fn(),
    onBell: vi.fn(),
    onReturned: vi.fn(),
  });
  const opening = windows.detach(project);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "project_window_open",
      expect.anything(),
      expect.anything(),
    ),
  );
  const closing = windows.deleteProject(project.id).then(() => order.push("deleted"));
  await vi.waitFor(() => expect(router.getCount(project.id)).toBe(0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  gate.resolve();
  await Promise.all([opening, closing]);
  expect(order).toEqual(["opened", "closed", "deleted"]);
  expect(vi.mocked(invoke).mock.invocationCallOrder).toHaveLength(2);
  windows.dispose();
});

it("does not count an adopted exited pane as a live PTY", async () => {
  const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
  const manager = router.getOrCreate(project);
  await manager.addPane(
    { id: "done" },
    {
      adoptPtyId: "done",
      skipStartupCmd: true,
      snapshot: { screen: "final", offset: 5, cols: 80, rows: 24, exited: true },
    },
  );
  expect(manager.specs()).toHaveLength(1);
  expect(manager.size).toBe(0);
  expect(manager.isLive("done")).toBe(false);
});

beforeEach(() => {
  fake.reset();
  events.clear();
  vi.clearAllMocks();
});

it("persists the union of local, whole-window and torn-window configs", async () => {
  const persist = vi.fn<(projectId: ProjectId, specs: TerminalSpec[]) => void>();
  const router = new TerminalRouter({ onPersistSpecs: persist, onPersistLayout: vi.fn() });
  const manager = router.getOrCreate(project);
  await manager.addPane({ title: "local" });
  await manager.addPane({ title: "torn", cwd: "/custom", launchArgs: ["--resume"] });
  const windows = await createProjectWindows({
    router,
    findProject: () => project,
    persistSpecs: persist,
    persistLayout: vi.fn(),
    onBell: vi.fn(),
    onReturned: vi.fn(),
  });
  await windows.tearOff(project, "pty-2");
  expect(persist.mock.lastCall?.[1].map((spec: { id: string }) => spec.id)).toEqual([
    "pty-1",
    "pty-2",
  ]);
  events.get("project-window:update")?.({
    payload: {
      windowId: "p1--pty-2",
      projectId: "p1",
      specs: [
        { id: "pty-2", title: "edited", cwd: "/custom", launchArgs: ["--resume"] },
        { id: "pty-3", title: "new" },
      ],
    },
  });
  expect(persist.mock.lastCall?.[1]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "pty-1", title: "local" }),
      expect.objectContaining({ id: "pty-2", title: "edited", launchArgs: ["--resume"] }),
      expect.objectContaining({ id: "pty-3", title: "new" }),
    ]),
  );
  await windows.detach(project);
  events.get("project-window:update")?.({
    payload: { windowId: "p1", projectId: "p1", specs: [{ id: "pty-1", title: "whole" }] },
  });
  expect(persist.mock.lastCall?.[1]).toHaveLength(3);
  windows.dispose();
});

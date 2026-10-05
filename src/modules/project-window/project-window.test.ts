import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TerminalManager } from "../terminal/terminal-manager";
import type { ProjectWindowState } from "./protocol";
import type { ProjectId } from "../workspaces/state/types";

const bridge = vi.hoisted(() => ({
  main: new Map<string, (event: { payload: unknown }) => void>(),
  external: new Map<string, (event: { payload: unknown }) => void | Promise<void>>(),
  close: null as (() => Promise<void>) | null,
  shortcuts: null as { newPane(): void; closeFocused(): void } | null,
  state: null as ProjectWindowState | null,
  spawn: vi.fn<() => Promise<string>>(),
  attach: vi.fn<() => Promise<{ data: string; offset: number }>>(),
  listenData: vi.fn<() => Promise<() => void>>(),
  kill: vi.fn().mockResolvedValue(undefined),
  queued: [] as Array<{ target: string; name: string; payload: unknown }>,
  delayAdoption: false,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, callback: (event: { payload: unknown }) => void) => {
    bridge.main.set(name, callback);
    return Promise.resolve(() => bridge.main.delete(name));
  }),
  emitTo: vi.fn((target: string, name: string, payload: unknown) => {
    if (target === "main") bridge.main.get(name)?.({ payload });
    else if (bridge.delayAdoption) bridge.queued.push({ target, name, payload });
    else void bridge.external.get(name)?.({ payload });
    return Promise.resolve();
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    listen: (name: string, callback: (event: { payload: unknown }) => void) => {
      bridge.external.set(name, callback);
      return Promise.resolve(() => bridge.external.delete(name));
    },
    onCloseRequested: (callback: () => Promise<void>) => {
      bridge.close = callback;
      return Promise.resolve(() => {});
    },
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../../shared/tauri/invoke", () => ({
  invoke: vi.fn((command: string, args?: { state?: ProjectWindowState }) => {
    if (command === "project_window_state") return Promise.resolve(bridge.state);
    if (command === "project_window_open") bridge.state = structuredClone(args!.state!);
    return Promise.resolve();
  }),
}));
vi.mock("../terminal/pty-client", () => ({
  ptySpawn: bridge.spawn,
  ptyAttach: bridge.attach,
  ptyKill: bridge.kill,
  ptyWrite: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  onPtyData: bridge.listenData,
  onPtyExit: () => Promise.resolve(() => {}),
}));
vi.mock("../../shared/keyboard/shortcuts", () => ({
  wireShortcuts: (callbacks: typeof bridge.shortcuts) => {
    bridge.shortcuts = callbacks;
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    activate() {}
    dispose() {}
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    activate() {}
    dispose() {}
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const managers: TerminalManager[] = [];
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  bridge.main.clear();
  bridge.external.clear();
  bridge.close = null;
  bridge.shortcuts = null;
  bridge.queued.length = 0;
  bridge.delayAdoption = false;
  bridge.spawn.mockResolvedValue("new");
  bridge.attach.mockResolvedValue({ data: "", offset: 0 });
  bridge.listenData.mockResolvedValue(() => {});
  bridge.state = {
    windowId: "p1",
    projectId: "p1",
    title: "project",
    payload: {
      path: "/repo",
      specs: [{ id: "a" }],
      layout: { type: "pane", paneId: "a" },
      activeCliId: "shell",
    },
  };
  document.body.innerHTML = '<div id="grid"></div>';
  document.body.inert = false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const { Terminal } = await import("@xterm/xterm");
  vi.spyOn(Terminal.prototype, "open").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose({ keepPty: true })));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function startWindow() {
  const { TerminalManager } = await import("../terminal/terminal-manager");
  const on = vi.spyOn(TerminalManager.prototype, "on");
  await import("./project-window");
  await vi.waitFor(() => expect(bridge.shortcuts).not.toBeNull());
  const manager = on.mock.contexts[0] as TerminalManager;
  managers.push(manager);
  return manager;
}

it("rejects shortcut mutations and late adoptions while a close is draining", async () => {
  const manager = await startWindow();
  const gate = deferred<string>();
  bridge.spawn.mockReturnValueOnce(gate.promise);
  bridge.shortcuts!.newPane();
  const closing = bridge.close!();
  bridge.shortcuts!.newPane();
  bridge.shortcuts!.closeFocused();
  await bridge.external.get("project-window:adopt")?.({
    payload: { adoptionId: "late-return", spec: { id: "return" }, snapshot: null },
  });
  expect(bridge.spawn).toHaveBeenCalledTimes(1);
  expect(bridge.attach).toHaveBeenCalledTimes(1);
  gate.resolve("late");
  await closing;
  expect(document.body.inert).toBe(true);
  expect(manager.ids()).toEqual(["a", "late"]);
  expect(bridge.kill).not.toHaveBeenCalled();
});

async function detachedProject(exited = true) {
  const { TerminalRouter } = await import("../../app/terminal-router");
  const { createProjectWindows } = await import("../../app/project-windows");
  const project = {
    id: "p1" as ProjectId,
    name: "project",
    path: "/repo",
  };
  const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
  const local = router.getOrCreate(project);
  managers.push(local);
  bridge.spawn.mockResolvedValueOnce("a").mockResolvedValueOnce("b");
  await local.addPane();
  await local.addPane();
  local.get("b")!.write("saved b", 7);
  if (exited) {
    local.get("b")!.markExited();
    local.markExited("b");
  }
  const windows = await createProjectWindows({
    router,
    findProject: () => project,
    persistSpecs: vi.fn(),
    persistLayout: vi.fn(),
    onBell: vi.fn(),
    onReturned: vi.fn(),
  });
  await windows.tearOff(project, "b");
  await windows.detach(project);
  const external = await startWindow();
  return { router, project, windows, external };
}
function closeNative(windowId: string) {
  bridge.main.get("project-window:closed")?.({ payload: { windowId } });
}

it("preserves the initial inventory when close arrives before listener registration finishes", async () => {
  const { emitTo } = await import("@tauri-apps/api/event");
  const { TerminalRouter } = await import("../../app/terminal-router");
  const { TerminalManager } = await import("../terminal/terminal-manager");
  const { createProjectWindows } = await import("../../app/project-windows");
  const project = { id: "p1" as ProjectId, name: "project", path: "/repo" };
  const persist = vi.fn();
  const router = new TerminalRouter({ onPersistSpecs: persist, onPersistLayout: vi.fn() });
  const local = router.getOrCreate(project);
  managers.push(local);
  bridge.spawn.mockResolvedValueOnce("a").mockResolvedValueOnce("b");
  await local.addPane();
  await local.addPane();
  const windows = await createProjectWindows({
    router,
    findProject: () => project,
    persistSpecs: vi.fn(),
    persistLayout: vi.fn(),
    onBell: vi.fn(),
    onReturned: vi.fn(),
  });
  await windows.detach(project);
  const gate = deferred<() => void>();
  bridge.listenData.mockReturnValueOnce(gate.promise);
  const on = vi.spyOn(TerminalManager.prototype, "on");
  await import("./project-window");
  await vi.waitFor(() => expect(bridge.close).not.toBeNull());
  managers.push(on.mock.contexts[0] as TerminalManager);
  const closing = bridge.close!();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    expect(
      vi.mocked(emitTo).mock.calls.some(([, , update]) => "snapshots" in (update as object)),
    ).toBe(false);
  } finally {
    gate.resolve(() => {});
  }
  await closing;
  closeNative("p1");
  await vi.waitFor(() => expect(router.getById(project.id)?.ids()).toEqual(["a", "b"]));
  managers.push(router.getById(project.id)!);
  expect(persist).toHaveBeenLastCalledWith(project.id, [
    expect.objectContaining({ id: "a" }),
    expect.objectContaining({ id: "b" }),
  ]);
  expect(bridge.attach).toHaveBeenCalledTimes(4);
  expect(bridge.kill).not.toHaveBeenCalled();
  windows.dispose();
});

it("keeps a returned exited pane until real adoption, despite intermediate inventory and whole-window close", async () => {
  const { router, project, windows, external } = await detachedProject();
  bridge.delayAdoption = true;
  bridge.main.get("project-window:closed")?.({ payload: { windowId: "p1--b" } });
  await vi.waitFor(() => expect(bridge.queued).toHaveLength(1));
  external.updateSpec("a", { title: "edited while adoption pending" });
  await bridge.close!();
  bridge.main.get("project-window:closed")?.({ payload: { windowId: "p1" } });
  await vi.waitFor(() => expect(router.getById(project.id)?.ids()).toContain("b"));
  const returned = router.getById(project.id)!;
  managers.push(returned);
  expect(returned.specs()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "a", title: "edited while adoption pending" }),
      expect.objectContaining({ id: "b" }),
    ]),
  );
  const snapshot = await returned.get("b")!.snapshot();
  expect(snapshot?.screen).toContain("saved b");
  expect(snapshot?.exited).toBe(true);
  expect(returned.isLive("b")).toBe(false);
  windows.dispose();
});

it("waits for real attachment acknowledgment when adoption overlaps close", async () => {
  const { emitTo } = await import("@tauri-apps/api/event");
  const { router, project, windows, external } = await detachedProject(false);
  const gate = deferred<{ data: string; offset: number }>();
  bridge.attach.mockReturnValueOnce(gate.promise);
  closeNative("p1--b");
  await vi.waitFor(() => expect(external.get("b")).toBeDefined());
  expect(
    vi.mocked(emitTo).mock.calls.some(([, , payload]) => "adopted" in (payload as object)),
  ).toBe(false);
  const closing = bridge.close!();
  expect(bridge.close!()).toBe(closing);
  expect(
    vi.mocked(emitTo).mock.calls.some(([, , payload]) => "snapshots" in (payload as object)),
  ).toBe(false);
  gate.resolve({ data: "tail", offset: 11 });
  await closing;
  expect(
    vi.mocked(emitTo).mock.calls.some(([, , payload]) => "adopted" in (payload as object)),
  ).toBe(true);
  closeNative("p1");
  await vi.waitFor(() => expect(router.getById(project.id)?.ids()).toContain("b"));
  expect((await router.getById(project.id)!.get("b")!.snapshot())?.screen).toContain("saved btail");
  windows.dispose();
});

it("does not resurrect an acknowledged pane or its snapshot after the pane is actually closed", async () => {
  const { emitTo } = await import("@tauri-apps/api/event");
  const { router, project, windows, external } = await detachedProject();
  closeNative("p1--b");
  await vi.waitFor(() =>
    expect(
      vi.mocked(emitTo).mock.calls.some(([, , payload]) => "adopted" in (payload as object)),
    ).toBe(true),
  );
  await external.close("b");
  await bridge.close!();
  closeNative("p1");
  await vi.waitFor(() => expect(router.getById(project.id)?.ids()).toEqual(["a"]));
  const returned = router.getById(project.id)!;
  expect(returned.get("b")).toBeUndefined();
  const final = vi
    .mocked(emitTo)
    .mock.calls.map(([, , payload]) => payload)
    .find((payload) => "snapshots" in (payload as object));
  expect(final).toMatchObject({ specs: [expect.objectContaining({ id: "a" })] });
  expect((final as { snapshots: object }).snapshots).not.toHaveProperty("b");
  windows.dispose();
});

it("keeps returning panes on main without sending adoption to an already closing whole window", async () => {
  const { emitTo } = await import("@tauri-apps/api/event");
  const { router, project, windows, external } = await detachedProject();
  const gate = deferred<void>();
  const pane = external.get("a")!;
  const snapshot = pane.snapshot.bind(pane);
  vi.spyOn(pane, "snapshot").mockImplementation(async () => {
    await gate.promise;
    return snapshot();
  });
  const closing = bridge.close!();
  closeNative("p1--b");
  gate.resolve();
  await closing;
  expect(vi.mocked(emitTo).mock.calls.some(([, name]) => name === "project-window:adopt")).toBe(
    false,
  );
  closeNative("p1");
  await vi.waitFor(() => expect(router.getById(project.id)?.ids()).toContain("b"));
  expect((await router.getById(project.id)!.get("b")!.snapshot())?.exited).toBe(true);
  windows.dispose();
});

it("drains an admitted pane close before capturing final inventory", async () => {
  const { emitTo } = await import("@tauri-apps/api/event");
  const manager = await startWindow();
  const gate = deferred<void>();
  bridge.kill.mockReturnValueOnce(gate.promise);
  const removing = manager.close("a");
  const closing = bridge.close!();
  gate.resolve();
  await Promise.all([removing, closing]);
  const final = vi
    .mocked(emitTo)
    .mock.calls.map(([, , payload]) => payload)
    .find((payload) => "snapshots" in (payload as object));
  expect(final).toMatchObject({ specs: [], layout: null, snapshots: {}, liveCount: 0 });
});

it("reports the final live count when a PTY exits while snapshots are flushing", async () => {
  const { emitTo } = await import("@tauri-apps/api/event");
  const manager = await startWindow();
  const gate = deferred<void>();
  const pane = manager.get("a")!;
  const snapshot = pane.snapshot.bind(pane);
  const capturing = vi.spyOn(pane, "snapshot").mockImplementation(async () => {
    await gate.promise;
    return snapshot();
  });
  const closing = bridge.close!();
  await vi.waitFor(() => expect(capturing).toHaveBeenCalled());
  pane.markExited();
  manager.markExited("a");
  gate.resolve();
  await closing;
  const final = vi
    .mocked(emitTo)
    .mock.calls.map(([, , payload]) => payload)
    .find((payload) => "snapshots" in (payload as object));
  expect(final).toMatchObject({ liveCount: 0, snapshots: { a: { exited: true } } });
});

it("the real close callback drains a delayed spawn before sending coherent frozen inventory", async () => {
  const { emitTo } = await import("@tauri-apps/api/event");
  const manager = await startWindow();
  const gate = deferred<string>();
  bridge.spawn.mockReturnValueOnce(gate.promise);
  bridge.shortcuts!.newPane();
  const closing = bridge.close!();
  await Promise.resolve();
  expect(
    vi.mocked(emitTo).mock.calls.some(([, , payload]) => "snapshots" in (payload as object)),
  ).toBe(false);
  gate.resolve("late");
  await closing;
  const final = vi
    .mocked(emitTo)
    .mock.calls.map(([, , payload]) => payload)
    .find((payload) => "snapshots" in (payload as object));
  expect(final).toMatchObject({
    specs: [expect.objectContaining({ id: "a" }), expect.objectContaining({ id: "late" })],
    snapshots: { a: expect.any(Object) as object, late: expect.any(Object) as object },
    layout: manager.layoutSnapshot,
  });
  expect(await manager.addPane()).toBeNull();
  await manager.close("a");
  expect(manager.ids()).toEqual(["a", "late"]);
  expect(bridge.kill).not.toHaveBeenCalled();
});

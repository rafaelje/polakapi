import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Project,
  ProjectId,
  Workspace,
  WorkspaceId,
  WorkspacesState,
} from "../../modules/workspaces/state/types";

interface MockStore {
  store: Map<string, unknown>;
  get: ReturnType<typeof vi.fn<(key: string) => Promise<unknown>>>;
  set: ReturnType<typeof vi.fn<(key: string, value: unknown) => Promise<void>>>;
  save: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

let mockStore: MockStore;

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(() => Promise.resolve(mockStore)),
}));

async function freshModule() {
  vi.resetModules();
  return await import("./workspaces-store");
}

function pid(id: string): ProjectId {
  return id as ProjectId;
}
function wid(id: string): WorkspaceId {
  return id as WorkspaceId;
}

function project(id: string, name: string, order?: number): Project {
  return { id: pid(id), name, path: `/tmp/${id}`, order };
}

function workspace(id: string, name: string, projects: Project[], order?: number): Workspace {
  return { id: wid(id), name, projects, order };
}

function sortByOrderThenName<T extends { name: string; order?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ao = a.order;
    const bo = b.order;
    if (ao !== undefined && bo !== undefined) return ao - bo;
    if (ao !== undefined) return -1;
    if (bo !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

describe("workspaces store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const store = new Map<string, unknown>();
    mockStore = {
      store,
      get: vi.fn((key: string) => Promise.resolve(store.get(key))),
      set: vi.fn((key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      save: vi.fn(() => Promise.resolve()),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty state when nothing is stored", async () => {
    const { loadWorkspaces, createEmptyWorkspacesState } = await freshModule();
    expect(await loadWorkspaces()).toEqual(createEmptyWorkspacesState());
  });

  it("discards persisted state with incompatible schemaVersion", async () => {
    mockStore.store.set("state", { schemaVersion: 99, workspaces: [], activeProjectId: null });
    const { loadWorkspaces, createEmptyWorkspacesState } = await freshModule();
    expect(await loadWorkspaces()).toEqual(createEmptyWorkspacesState());
  });

  it("loads a valid persisted state untouched", async () => {
    const state: WorkspacesState = {
      schemaVersion: 1,
      activeProjectId: pid("p1"),
      workspaces: [workspace("w1", "Alpha", [project("p1", "One")])],
    };
    mockStore.store.set("state", state);
    const { loadWorkspaces } = await freshModule();
    expect(await loadWorkspaces()).toEqual(state);
  });

  it("queueSaveWorkspaces debounces writes to the latest snapshot", async () => {
    const { queueSaveWorkspaces, flushSaveWorkspaces, createEmptyWorkspacesState } =
      await freshModule();
    const s1 = { ...createEmptyWorkspacesState(), activeProjectId: pid("a") };
    const s2 = { ...createEmptyWorkspacesState(), activeProjectId: pid("b") };
    queueSaveWorkspaces(s1);
    queueSaveWorkspaces(s2);
    expect(mockStore.set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    await flushSaveWorkspaces();

    expect(mockStore.set).toHaveBeenCalledTimes(1);
    expect(mockStore.set.mock.calls[0]).toEqual(["state", s2]);
    expect(mockStore.save).toHaveBeenCalled();
  });

  it("setActive (activeProjectId) round-trips through persistence", async () => {
    const { queueSaveWorkspaces, flushSaveWorkspaces, loadWorkspaces, createEmptyWorkspacesState } =
      await freshModule();
    const state: WorkspacesState = {
      ...createEmptyWorkspacesState(),
      workspaces: [workspace("w1", "W", [project("p1", "P1"), project("p2", "P2")])],
      activeProjectId: pid("p2"),
    };
    queueSaveWorkspaces(state);
    await flushSaveWorkspaces();
    expect(await loadWorkspaces()).toEqual(state);
  });

  it("persists CRUD-style snapshots: create, update, delete workspace", async () => {
    const { queueSaveWorkspaces, flushSaveWorkspaces, loadWorkspaces, createEmptyWorkspacesState } =
      await freshModule();

    // create
    let state: WorkspacesState = {
      ...createEmptyWorkspacesState(),
      workspaces: [workspace("w1", "First", [])],
    };
    queueSaveWorkspaces(state);
    await flushSaveWorkspaces();
    expect((await loadWorkspaces()).workspaces).toHaveLength(1);

    // update (rename)
    state = { ...state, workspaces: [{ ...state.workspaces[0], name: "Renamed" }] };
    queueSaveWorkspaces(state);
    await flushSaveWorkspaces();
    expect((await loadWorkspaces()).workspaces[0].name).toBe("Renamed");

    // delete
    state = { ...state, workspaces: [] };
    queueSaveWorkspaces(state);
    await flushSaveWorkspaces();
    expect((await loadWorkspaces()).workspaces).toEqual([]);
  });

  it("sorts workspaces and projects by order then alphabetically", () => {
    const items = [
      workspace("a", "Banana", [], undefined),
      workspace("b", "Apple", [], undefined),
      workspace("c", "Zed", [], 0),
      workspace("d", "Mid", [], 2),
    ];
    const sorted = sortByOrderThenName(items).map((w) => w.name);
    expect(sorted).toEqual(["Zed", "Mid", "Apple", "Banana"]);

    const projects = [
      project("p1", "Cee", undefined),
      project("p2", "Aye", 5),
      project("p3", "Bee", undefined),
      project("p4", "Dee", 1),
    ];
    const sortedP = sortByOrderThenName(projects).map((p) => p.name);
    expect(sortedP).toEqual(["Dee", "Aye", "Bee", "Cee"]);
  });

  it("moveProject across workspaces preserves the project and its id", async () => {
    const { queueSaveWorkspaces, flushSaveWorkspaces, loadWorkspaces, createEmptyWorkspacesState } =
      await freshModule();
    const proj = project("p1", "Migrating");
    let state: WorkspacesState = {
      ...createEmptyWorkspacesState(),
      workspaces: [workspace("w1", "From", [proj]), workspace("w2", "To", [])],
    };
    queueSaveWorkspaces(state);
    await flushSaveWorkspaces();

    // simulate moveProject(p1, w1 -> w2)
    state = {
      ...state,
      workspaces: [
        { ...state.workspaces[0], projects: [] },
        { ...state.workspaces[1], projects: [proj] },
      ],
    };
    queueSaveWorkspaces(state);
    await flushSaveWorkspaces();

    const loaded = await loadWorkspaces();
    expect(loaded.workspaces[0].projects).toEqual([]);
    expect(loaded.workspaces[1].projects).toEqual([proj]);
    expect(loaded.workspaces[1].projects[0].id).toBe(proj.id);
  });

  it("enforces unique IDs across workspaces and projects in a snapshot", () => {
    const state: WorkspacesState = {
      schemaVersion: 1,
      activeProjectId: null,
      workspaces: [
        workspace("w1", "A", [project("p1", "x"), project("p2", "y")]),
        workspace("w2", "B", [project("p3", "z")]),
      ],
    };
    const wIds = state.workspaces.map((w) => w.id);
    const pIds = state.workspaces.flatMap((w) => w.projects.map((p) => p.id));
    expect(new Set(wIds).size).toBe(wIds.length);
    expect(new Set(pIds).size).toBe(pIds.length);
    expect(new Set([...wIds, ...pIds]).size).toBe(wIds.length + pIds.length);
  });

  it("restores pending on store failure so the next flush retries", async () => {
    mockStore.set.mockRejectedValueOnce(new Error("disk full"));
    const { queueSaveWorkspaces, flushSaveWorkspaces, createEmptyWorkspacesState } =
      await freshModule();
    const state = { ...createEmptyWorkspacesState(), activeProjectId: pid("retry") };
    queueSaveWorkspaces(state);
    await expect(flushSaveWorkspaces()).rejects.toThrow("disk full");

    mockStore.set.mockResolvedValueOnce(undefined);
    await flushSaveWorkspaces();
    expect(mockStore.set).toHaveBeenLastCalledWith("state", state);
  });
});

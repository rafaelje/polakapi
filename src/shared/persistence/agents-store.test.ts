import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDef, AgentsState } from "../../modules/agents-library/types";

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
  return await import("./agents-store");
}

function agent(id: string, name: string, createdAt = 1_000_000): AgentDef {
  return {
    id,
    name,
    description: "",
    files: [{ id: `${id}-f`, title: "only.md", content: "hello" }],
    createdAt,
    updatedAt: createdAt,
  };
}

describe("agents store", () => {
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
    const { loadAgents, createEmptyAgentsState } = await freshModule();
    expect(await loadAgents()).toEqual(createEmptyAgentsState());
  });

  it("returns empty state for incompatible schemaVersion (silent fallback)", async () => {
    mockStore.store.set("state", { schemaVersion: 99, agents: [] });
    const { loadAgents, createEmptyAgentsState } = await freshModule();
    expect(await loadAgents()).toEqual(createEmptyAgentsState());
  });

  it("rejects malformed payload missing the agents array", async () => {
    mockStore.store.set("state", { schemaVersion: 1 });
    const { loadAgents, createEmptyAgentsState } = await freshModule();
    expect(await loadAgents()).toEqual(createEmptyAgentsState());
  });

  it("loads a valid persisted state untouched", async () => {
    const state: AgentsState = {
      schemaVersion: 1,
      agents: [agent("a1", "frontend reviewer")],
    };
    mockStore.store.set("state", state);
    const { loadAgents } = await freshModule();
    expect(await loadAgents()).toEqual(state);
  });

  it("queueSaveAgents debounces writes to the latest snapshot", async () => {
    const { queueSaveAgents, flushSaveAgents, createEmptyAgentsState } = await freshModule();
    const s1: AgentsState = { ...createEmptyAgentsState(), agents: [agent("a", "one")] };
    const s2: AgentsState = {
      ...createEmptyAgentsState(),
      agents: [agent("a", "one"), agent("b", "two")],
    };
    queueSaveAgents(s1);
    queueSaveAgents(s2);
    expect(mockStore.set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    await flushSaveAgents();

    expect(mockStore.set).toHaveBeenCalledTimes(1);
    expect(mockStore.set.mock.calls[0]).toEqual(["state", s2]);
    expect(mockStore.save).toHaveBeenCalled();
  });

  it("round-trips create / rename / delete snapshots", async () => {
    const { queueSaveAgents, flushSaveAgents, loadAgents, createEmptyAgentsState } =
      await freshModule();

    let state: AgentsState = { ...createEmptyAgentsState(), agents: [agent("p1", "first")] };
    queueSaveAgents(state);
    await flushSaveAgents();
    expect((await loadAgents()).agents).toHaveLength(1);

    state = { ...state, agents: [{ ...state.agents[0], name: "renamed" }] };
    queueSaveAgents(state);
    await flushSaveAgents();
    expect((await loadAgents()).agents[0].name).toBe("renamed");

    state = { ...state, agents: [] };
    queueSaveAgents(state);
    await flushSaveAgents();
    expect((await loadAgents()).agents).toEqual([]);
  });

  it("restores pending on store failure so the next flush retries", async () => {
    mockStore.set.mockRejectedValueOnce(new Error("disk full"));
    const { queueSaveAgents, flushSaveAgents, createEmptyAgentsState } = await freshModule();
    const state: AgentsState = { ...createEmptyAgentsState(), agents: [agent("retry", "boom")] };
    queueSaveAgents(state);
    await expect(flushSaveAgents()).rejects.toThrow("disk full");

    mockStore.set.mockResolvedValueOnce(undefined);
    await flushSaveAgents();
    expect(mockStore.set).toHaveBeenLastCalledWith("state", state);
  });

  it("flushSaveAgents is a noop when nothing is queued", async () => {
    const { flushSaveAgents } = await freshModule();
    await flushSaveAgents();
    expect(mockStore.set).not.toHaveBeenCalled();
    expect(mockStore.save).not.toHaveBeenCalled();
  });
});

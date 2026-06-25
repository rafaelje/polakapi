import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LoopProfile,
  LoopProfileId,
  LoopProfilesState,
} from "../../modules/loop/state/types";
import { createDefaultMatrix } from "../../modules/loop/state/types";

// Reusing the mock shape from the workspaces store — vi.hoisted doesn't play
// well with vi.mock here; we replicate the pattern letter by letter. See
// `workspaces-store.test.ts:11`.

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
  return await import("./loop-profiles-store");
}

function lpid(id: string): LoopProfileId {
  return id as LoopProfileId;
}

function profile(id: string, name: string, createdAt = 1_000_000): LoopProfile {
  return {
    id: lpid(id),
    name,
    createdAt,
    matrix: createDefaultMatrix(),
  };
}

describe("loop profiles store", () => {
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
    const { loadLoopProfiles, createEmptyLoopProfilesState } = await freshModule();
    expect(await loadLoopProfiles()).toEqual(createEmptyLoopProfilesState());
  });

  it("returns empty state for incompatible schemaVersion (silent fallback)", async () => {
    // Matches the "Schema version incompatible" requirement of loop-profiles/spec.md:
    // "the system treats it as empty (silent fallback, same as workspaces-store.ts)".
    mockStore.store.set("state", { schemaVersion: 99, profiles: [] });
    const { loadLoopProfiles, createEmptyLoopProfilesState } = await freshModule();
    expect(await loadLoopProfiles()).toEqual(createEmptyLoopProfilesState());
  });

  it("rejects malformed payload missing the profiles array", async () => {
    mockStore.store.set("state", { schemaVersion: 1 });
    const { loadLoopProfiles, createEmptyLoopProfilesState } = await freshModule();
    expect(await loadLoopProfiles()).toEqual(createEmptyLoopProfilesState());
  });

  it("loads a valid persisted state untouched", async () => {
    const state: LoopProfilesState = {
      schemaVersion: 1,
      profiles: [profile("p1", "my-mixed")],
    };
    mockStore.store.set("state", state);
    const { loadLoopProfiles } = await freshModule();
    expect(await loadLoopProfiles()).toEqual(state);
  });

  it("queueSaveLoopProfiles debounces writes to the latest snapshot", async () => {
    const { queueSaveLoopProfiles, flushSaveLoopProfiles, createEmptyLoopProfilesState } =
      await freshModule();
    const s1: LoopProfilesState = {
      ...createEmptyLoopProfilesState(),
      profiles: [profile("a", "one")],
    };
    const s2: LoopProfilesState = {
      ...createEmptyLoopProfilesState(),
      profiles: [profile("a", "one"), profile("b", "two")],
    };
    queueSaveLoopProfiles(s1);
    queueSaveLoopProfiles(s2);
    expect(mockStore.set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    await flushSaveLoopProfiles();

    expect(mockStore.set).toHaveBeenCalledTimes(1);
    expect(mockStore.set.mock.calls[0]).toEqual(["state", s2]);
    expect(mockStore.save).toHaveBeenCalled();
  });

  it("round-trips create / rename / delete snapshots", async () => {
    const { queueSaveLoopProfiles, flushSaveLoopProfiles, loadLoopProfiles, createEmptyLoopProfilesState } =
      await freshModule();

    // create
    let state: LoopProfilesState = {
      ...createEmptyLoopProfilesState(),
      profiles: [profile("p1", "first-profile")],
    };
    queueSaveLoopProfiles(state);
    await flushSaveLoopProfiles();
    expect((await loadLoopProfiles()).profiles).toHaveLength(1);

    // rename
    state = {
      ...state,
      profiles: [{ ...state.profiles[0], name: "renamed" }],
    };
    queueSaveLoopProfiles(state);
    await flushSaveLoopProfiles();
    expect((await loadLoopProfiles()).profiles[0].name).toBe("renamed");

    // delete
    state = { ...state, profiles: [] };
    queueSaveLoopProfiles(state);
    await flushSaveLoopProfiles();
    expect((await loadLoopProfiles()).profiles).toEqual([]);
  });

  it("restores pending on store failure so the next flush retries", async () => {
    mockStore.set.mockRejectedValueOnce(new Error("disk full"));
    const { queueSaveLoopProfiles, flushSaveLoopProfiles, createEmptyLoopProfilesState } =
      await freshModule();
    const state: LoopProfilesState = {
      ...createEmptyLoopProfilesState(),
      profiles: [profile("retry", "boom")],
    };
    queueSaveLoopProfiles(state);
    await expect(flushSaveLoopProfiles()).rejects.toThrow("disk full");

    mockStore.set.mockResolvedValueOnce(undefined);
    await flushSaveLoopProfiles();
    expect(mockStore.set).toHaveBeenLastCalledWith("state", state);
  });

  it("default matrix factory yields all 5 agents pointing to claude/opus-4-7", () => {
    const matrix = createDefaultMatrix();
    // loop-profiles/spec.md: "default without profile loaded = all claude/opus-4-7"
    for (const role of [
      "analysis",
      "implementation",
      "review",
      "knowledge",
      "integration",
    ] as const) {
      expect(matrix[role].cli).toBe("claude");
      expect(matrix[role].model).toBe("claude-opus-4-7");
    }
  });

  it("flushSaveLoopProfiles is a noop when nothing is queued", async () => {
    const { flushSaveLoopProfiles } = await freshModule();
    await flushSaveLoopProfiles();
    expect(mockStore.set).not.toHaveBeenCalled();
    expect(mockStore.save).not.toHaveBeenCalled();
  });
});

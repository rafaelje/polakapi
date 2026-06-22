import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  return await import("./persistence");
}

describe("persistence", () => {
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

  it("returns empty layout when nothing is stored", async () => {
    const { loadLayout } = await freshModule();
    expect(await loadLayout()).toEqual({});
  });

  it("queueSave debounces writes and merges patches", async () => {
    const { queueSave, flushSave } = await freshModule();
    queueSave({ sidebarLeftWidth: 220 });
    queueSave({ sidebarRightWidth: 260 });
    expect(mockStore.set).not.toHaveBeenCalled();

    // First tick triggers the debounced save
    await vi.advanceTimersByTimeAsync(250);
    await flushSave();

    expect(mockStore.set).toHaveBeenCalledTimes(1);
    expect(mockStore.set.mock.calls[0]).toEqual([
      "layout",
      { sidebarLeftWidth: 220, sidebarRightWidth: 260 },
    ]);
    expect(mockStore.save).toHaveBeenCalled();
  });

  it("merges later writes on top of stored values", async () => {
    const initial = { sidebarLeftWidth: 100, hideLeft: true };
    mockStore.store.set("layout", initial);
    const { queueSave, flushSave } = await freshModule();

    queueSave({ sidebarLeftWidth: 200 });
    await flushSave();

    expect(mockStore.set).toHaveBeenCalledWith("layout", {
      sidebarLeftWidth: 200,
      hideLeft: true,
    });
  });

  it("flushSave is a no-op when queue is empty", async () => {
    const { flushSave } = await freshModule();
    await flushSave();
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it("does not lose writes queued during an in-flight flush", async () => {
    let releaseGet: () => void = () => {};
    const blockedGet = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    mockStore.get.mockImplementationOnce((key: string) =>
      blockedGet.then(() => mockStore.store.get(key)),
    );

    const { queueSave, flushSave } = await freshModule();
    queueSave({ sidebarLeftWidth: 100 });
    const flush1 = flushSave();
    queueSave({ sidebarRightWidth: 200 });
    releaseGet();
    await flush1;

    expect(mockStore.set).toHaveBeenLastCalledWith("layout", { sidebarLeftWidth: 100 });

    await flushSave();
    expect(mockStore.set).toHaveBeenLastCalledWith("layout", {
      sidebarLeftWidth: 100,
      sidebarRightWidth: 200,
    });
  });

  it("restores pending on store failure so the next flush retries", async () => {
    mockStore.set.mockRejectedValueOnce(new Error("disk full"));
    const { queueSave, flushSave } = await freshModule();
    queueSave({ sidebarLeftWidth: 321 });
    await expect(flushSave()).rejects.toThrow("disk full");

    mockStore.set.mockResolvedValueOnce(undefined);
    await flushSave();
    expect(mockStore.set).toHaveBeenLastCalledWith("layout", { sidebarLeftWidth: 321 });
  });
});

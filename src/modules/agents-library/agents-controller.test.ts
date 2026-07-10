import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentsState } from "./types";

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
  return await import("./agents-controller");
}

function seed(state: AgentsState): void {
  mockStore.store.set("state", state);
}

describe("agents controller", () => {
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

  it("boots with the persisted state", async () => {
    seed({
      schemaVersion: 1,
      agents: [
        {
          id: "seed",
          name: "seeded",
          description: "",
          files: [{ id: "f", title: "a.md", content: "x" }],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const { createAgentsController } = await freshModule();
    const c = await createAgentsController({ now: () => 100 });
    expect(c.getState().agents.map((a) => a.name)).toEqual(["seeded"]);
  });

  it("create adds an agent, stamps timestamps, and queues a save", async () => {
    const { createAgentsController } = await freshModule();
    const c = await createAgentsController({ now: () => 1_000 });
    const listener = vi.fn();
    c.subscribe(listener);
    const created = c.create({
      name: "  frontend reviewer  ",
      description: "  react checklist  ",
      files: [{ title: "review.md", content: "check hooks" }],
    });
    expect(created.name).toBe("frontend reviewer"); // trimmed
    expect(created.description).toBe("react checklist"); // trimmed
    expect(created.createdAt).toBe(1_000);
    expect(created.updatedAt).toBe(1_000);
    expect(listener).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(mockStore.set).toHaveBeenCalledTimes(1);
  });

  it("create rejects duplicate name (case + whitespace insensitive)", async () => {
    const { createAgentsController, DuplicateAgentNameError } = await freshModule();
    const c = await createAgentsController({ now: () => 1 });
    c.create({
      name: "Frontend Reviewer",
      description: "",
      files: [{ title: "a.md", content: "x" }],
    });
    expect(() =>
      c.create({
        name: "  frontend reviewer  ",
        description: "",
        files: [{ title: "b.md", content: "y" }],
      }),
    ).toThrow(DuplicateAgentNameError);
  });

  it("create requires a non-empty name and at least one file with content", async () => {
    const { createAgentsController } = await freshModule();
    const c = await createAgentsController({ now: () => 1 });
    expect(() =>
      c.create({ name: "  ", description: "", files: [{ title: "a", content: "x" }] }),
    ).toThrow(/name is required/);
    expect(() => c.create({ name: "n", description: "", files: [] })).toThrow(/at least one file/);
    expect(() =>
      c.create({ name: "n", description: "", files: [{ title: "a", content: "  \n  " }] }),
    ).toThrow(/at least one file with content/);
  });

  it("update bumps updatedAt and preserves createdAt", async () => {
    const { createAgentsController } = await freshModule();
    let clock = 100;
    const c = await createAgentsController({ now: () => clock });
    const a = c.create({
      name: "orig",
      description: "",
      files: [{ title: "a.md", content: "x" }],
    });
    clock = 500;
    const b = c.update(a.id, { description: "updated" });
    expect(b.createdAt).toBe(100);
    expect(b.updatedAt).toBe(500);
    expect(b.description).toBe("updated");
    expect(b.name).toBe("orig");
  });

  it("update rejects rename to a taken name but allows same-name no-op", async () => {
    const { createAgentsController, DuplicateAgentNameError } = await freshModule();
    const c = await createAgentsController({ now: () => 1 });
    const a = c.create({ name: "alpha", description: "", files: [{ title: "a", content: "x" }] });
    c.create({ name: "beta", description: "", files: [{ title: "b", content: "y" }] });
    expect(() => c.update(a.id, { name: "beta" })).toThrow(DuplicateAgentNameError);
    // Passing the same name back through is allowed.
    expect(c.update(a.id, { name: "alpha" }).name).toBe("alpha");
  });

  it("remove drops the agent and notifies", async () => {
    const { createAgentsController } = await freshModule();
    const c = await createAgentsController({ now: () => 1 });
    const a = c.create({ name: "toss", description: "", files: [{ title: "a", content: "x" }] });
    const listener = vi.fn();
    c.subscribe(listener);
    c.remove(a.id);
    expect(c.getState().agents).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("remove of unknown id is a silent no-op (no emit, no save)", async () => {
    const { createAgentsController } = await freshModule();
    const c = await createAgentsController({ now: () => 1 });
    const listener = vi.fn();
    c.subscribe(listener);
    c.remove("does-not-exist");
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(mockStore.set).not.toHaveBeenCalled();
  });

  it("subscribe returns an unsubscribe function", async () => {
    const { createAgentsController } = await freshModule();
    const c = await createAgentsController({ now: () => 1 });
    const listener = vi.fn();
    const unsub = c.subscribe(listener);
    unsub();
    c.create({ name: "x", description: "", files: [{ title: "a", content: "x" }] });
    expect(listener).not.toHaveBeenCalled();
  });
});

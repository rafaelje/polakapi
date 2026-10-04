import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalLayoutNode } from "../modules/terminal/terminal-layout";
import type { Project, ProjectId } from "../modules/workspaces/state/types";

const managerFake = vi.hoisted(() => {
  let listener: ((event: unknown) => void) | null = null;
  return {
    reset(): void {
      listener = null;
    },
    emit(event: unknown): void {
      listener?.(event);
    },
    setListener(next: (event: unknown) => void): void {
      listener = next;
    },
  };
});

const managerCalls = vi.hoisted(() => ({
  dispose: [] as unknown[],
  restore: [] as unknown[],
}));

vi.mock("../modules/terminal/terminal-manager", () => ({
  TerminalManager: class {
    readonly gridEl = document.createElement("div");
    readonly size = 0;
    constructor(readonly options: unknown) {}
    on(listener: (event: unknown) => void): () => void {
      managerFake.setListener(listener);
      return () => undefined;
    }
    setNotificationContext(): void {}
    ids(): string[] {
      return [];
    }
    specs(): unknown[] {
      return [{ id: "pty-1" }];
    }
    get layoutSnapshot(): unknown {
      return { type: "pane", paneId: "pty-1" };
    }
    getActiveCli(): string {
      return "claude";
    }
    dispose(opts?: unknown): Promise<void> {
      managerCalls.dispose.push(opts);
      return Promise.resolve();
    }
    restoreSpecs(specs: unknown, opts?: unknown): Promise<void> {
      managerCalls.restore.push([specs, opts]);
      return Promise.resolve();
    }
  },
}));

vi.mock("../modules/terminal/pty-client", () => ({ ptyKill: vi.fn() }));

import { TerminalRouter } from "./terminal-router";

function pid(value: string): ProjectId {
  return value as ProjectId;
}

function project(): Project {
  return { id: pid("p1"), name: "Project", path: "/tmp/project" };
}

describe("TerminalRouter layout persistence", () => {
  beforeEach(() => managerFake.reset());

  it("forwards layout changes to the persistence callback", () => {
    const onPersistLayout = vi.fn();
    const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout });
    router.getOrCreate(project());
    const layout: TerminalLayoutNode = { type: "pane", paneId: "pty-1" };

    managerFake.emit({ type: "layout-changed", projectId: pid("p1"), layout });

    expect(onPersistLayout).toHaveBeenCalledExactlyOnceWith(pid("p1"), layout);
  });
});

describe("TerminalRouter handing a grid to another window", () => {
  beforeEach(() => {
    managerFake.reset();
    managerCalls.dispose.length = 0;
    managerCalls.restore.length = 0;
  });

  it("releases the grid without killing its processes", async () => {
    const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
    router.getOrCreate(project());

    const grid = await router.release(pid("p1"));

    expect(grid).toEqual({
      specs: [{ id: "pty-1" }],
      layout: { type: "pane", paneId: "pty-1" },
      activeCliId: "claude",
      snapshots: {},
    });
    expect(managerCalls.dispose).toEqual([{ keepPty: true }]);
    expect(router.getById(pid("p1"))).toBeNull();
    expect(await router.release(pid("p1"))).toBeNull();
  });

  it("keeps counting panes that live in another window", () => {
    const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
    router.setExternalCount("w1", pid("p1"), 3);
    expect(router.getCount(pid("p1"))).toBe(3);
    expect(router.totalLiveCount()).toBe(3);
    expect(router.liveCountsByProject().get(pid("p1"))).toBe(3);
    router.setExternalCount("w1", pid("p1"), null);
    expect(router.getCount(pid("p1"))).toBe(0);
  });

  it("adopts running processes instead of spawning when the grid returns", async () => {
    const router = new TerminalRouter({ onPersistSpecs: vi.fn(), onPersistLayout: vi.fn() });
    const grid = {
      specs: [{ id: "pty-1" }],
      layout: { type: "pane" as const, paneId: "pty-1" },
      activeCliId: "codex",
    };

    const manager = await router.adopt(project(), grid);

    expect(router.getById(pid("p1"))).toBe(manager);
    expect(managerCalls.restore).toEqual([[grid.specs, { adopt: true }]]);
    expect((manager as unknown as { options: { activeCliId: string } }).options.activeCliId).toBe(
      "codex",
    );
  });
});

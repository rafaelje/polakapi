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

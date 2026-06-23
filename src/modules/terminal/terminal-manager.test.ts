import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectId } from "../workspaces/types";
import type { PaneCreateOptions, TerminalSpec } from "./types";

const fake = vi.hoisted(() => {
  const attachCalls: Array<{ opts: PaneCreateOptions | undefined; ptyId: string }> = [];
  let nextId = 1;
  return {
    attachCalls,
    reset(): void {
      attachCalls.length = 0;
      nextId = 1;
    },
    mintPtyId(): string {
      return `pty-${nextId++}`;
    },
  };
});

vi.mock("./terminal-pane", () => {
  class FakeTerminalPane {
    ptyId = "";
    readonly el: HTMLElement = document.createElement("div");
    readonly bodyEl: HTMLElement = document.createElement("div");
    readonly titleEl: HTMLElement = document.createElement("div");
    readonly closeBtn: HTMLButtonElement = document.createElement("button");

    attach(host: HTMLElement, opts?: PaneCreateOptions): Promise<void> {
      this.ptyId = fake.mintPtyId();
      fake.attachCalls.push({ opts, ptyId: this.ptyId });
      host.append(this.el);
      return Promise.resolve();
    }

    bytesReceived = 0;
    fit(): void {}
    focus(): void {}
    write(): void {}
    markExited(): void {}
    markSpawnFailed(): void {}
    setStartupCmdCallbacks(): void {}
    setCliRespawnCallbacks(): void {}
    onBell(): { dispose(): void } {
      return { dispose: () => undefined };
    }
    dispose(): Promise<void> {
      this.el.remove();
      return Promise.resolve();
    }
  }
  return { TerminalPane: FakeTerminalPane };
});

vi.mock("./pty-client", () => ({
  ptyWrite: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptySpawn: vi.fn().mockResolvedValue("ignored"),
}));

vi.mock("./terminal-notifications", () => ({
  registerBellNotification: vi.fn(() => ({ dispose: () => undefined })),
}));

vi.mock("./terminal-grid-layout", () => ({
  layoutTerminalGrid: vi.fn(),
}));

import { TerminalManager } from "./terminal-manager";

function pid(id: string): ProjectId {
  return id as ProjectId;
}

function makeManager(): TerminalManager {
  return new TerminalManager({
    projectId: pid("p1"),
    defaultCwd: "/tmp/project",
    gridCols: 2,
  });
}

describe("TerminalManager CLI wiring", () => {
  beforeEach(() => {
    fake.reset();
  });

  it("defaults to the shell profile when no spec and no activeCli set", async () => {
    const manager = makeManager();
    expect(manager.getActiveCli()).toBe("shell");

    await manager.addPane();

    expect(fake.attachCalls).toHaveLength(1);
    expect(fake.attachCalls[0]?.opts?.command).toBeUndefined();
    expect(fake.attachCalls[0]?.opts?.args).toBeUndefined();
    expect(fake.attachCalls[0]?.opts?.cwd).toBe("/tmp/project");

    const [spec] = manager.specs();
    expect(spec?.cliId).toBe("shell");
  });

  it("uses activeCliId when addPane is called without an explicit cliId", async () => {
    const manager = makeManager();
    manager.setActiveCli("claude");

    await manager.addPane();

    expect(fake.attachCalls[0]?.opts?.command).toBe("claude");

    const [spec] = manager.specs();
    expect(spec?.cliId).toBe("claude");
  });

  it("lets an explicit spec.cliId override the manager activeCliId", async () => {
    const manager = makeManager();
    manager.setActiveCli("claude");

    await manager.addPane({ cliId: "codex" });

    expect(fake.attachCalls[0]?.opts?.command).toBe("codex");

    const [spec] = manager.specs();
    expect(spec?.cliId).toBe("codex");
  });

  it("falls back to the shell profile for an unknown cliId", async () => {
    const manager = makeManager();

    await manager.addPane({ cliId: "definitely-not-a-cli" });

    expect(fake.attachCalls[0]?.opts?.command).toBeUndefined();

    const [spec] = manager.specs();
    expect(spec?.cliId).toBe("shell");
  });

  it("restoreSpecs spawns each pane with its persisted cliId", async () => {
    const manager = makeManager();
    const specs: TerminalSpec[] = [
      { id: "ignored-1", cliId: "claude" },
      { id: "ignored-2", cliId: "codex" },
      { id: "ignored-3" },
    ];

    await manager.restoreSpecs(specs);

    expect(fake.attachCalls[0]?.opts?.command).toBe("claude");
    expect(fake.attachCalls[1]?.opts?.command).toBe("codex");
    expect(fake.attachCalls[2]?.opts?.command).toBeUndefined();

    const out = manager.specs();
    expect(out.map((s) => s.cliId)).toEqual(["claude", "codex", "shell"]);
  });

  it("forwards cliId through attach opts so the badge can render", async () => {
    const manager = makeManager();
    manager.setActiveCli("codex");

    await manager.addPane();

    expect(fake.attachCalls[0]?.opts?.cliId).toBe("codex");
  });

  it("respawnPane preserves cwd / title / startupCmd and updates cliId", async () => {
    const manager = makeManager();
    await manager.addPane({ title: "build", cwd: "/srv", startupCmd: "pnpm dev" });

    const [oldSpec] = manager.specs();
    if (!oldSpec) throw new Error("expected an initial spec");
    expect(oldSpec.cliId).toBe("shell");

    await manager.respawnPane(oldSpec.id, "claude");

    const [newSpec] = manager.specs();
    expect(newSpec?.cliId).toBe("claude");
    expect(newSpec?.title).toBe("build");
    expect(newSpec?.cwd).toBe("/srv");
    expect(newSpec?.startupCmd).toBe("pnpm dev");
    // The id changes because a new PTY is minted.
    expect(newSpec?.id).not.toBe(oldSpec.id);
  });

  it("respawnPane preserves the pane's grid slot", async () => {
    const manager = makeManager();
    await manager.addPane({ title: "a" });
    await manager.addPane({ title: "b" });
    await manager.addPane({ title: "c" });

    const before = manager.ids();
    const targetId = before[1];
    if (!targetId) throw new Error("expected three panes");
    const leftId = before[0];
    const rightId = before[2];

    await manager.respawnPane(targetId, "claude");

    const after = manager.ids();
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(leftId);
    expect(after[2]).toBe(rightId);
    expect(after[1]).not.toBe(targetId);
    expect(manager.specs()[1]?.cliId).toBe("claude");
    expect(manager.specs()[1]?.title).toBe("b");
  });
});

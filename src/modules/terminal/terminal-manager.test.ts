import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LayoutTemplate, ProjectId } from "../workspaces/state/types";
import { terminalLayoutPaneIds, type TerminalLayoutNode } from "./terminal-layout";
import type { PaneCreateOptions, TerminalSpec } from "./types";

const fake = vi.hoisted(() => {
  const attachCalls: Array<{ opts: PaneCreateOptions | undefined; ptyId: string }> = [];
  const placeholderCalls: Array<{ cliId?: string }> = [];
  const panesByPtyId = new Map<string, { onCommand(command: string): void } | null>();
  let nextId = 1;
  return {
    attachCalls,
    placeholderCalls,
    panesByPtyId,
    reset(): void {
      attachCalls.length = 0;
      placeholderCalls.length = 0;
      panesByPtyId.clear();
      nextId = 1;
    },
    mintPtyId(): string {
      return `pty-${nextId++}`;
    },
    /** Simulates the OSC handler firing for a shell-integration command capture. */
    emitShellCommand(ptyId: string, command: string): void {
      panesByPtyId.get(ptyId)?.onCommand(command);
    },
  };
});

vi.mock("./terminal-pane", () => {
  class FakeTerminalPane {
    ptyId = "";
    readonly el: HTMLElement = document.createElement("div");
    readonly headerEl: HTMLElement = document.createElement("div");
    readonly bodyEl: HTMLElement = document.createElement("div");
    readonly titleEl: HTMLElement = document.createElement("div");
    readonly closeBtn: HTMLButtonElement = document.createElement("button");

    attach(host: HTMLElement, opts?: PaneCreateOptions): Promise<void> {
      this.ptyId = fake.mintPtyId();
      fake.attachCalls.push({ opts, ptyId: this.ptyId });
      host.append(this.el);
      return Promise.resolve();
    }

    hasOutput = false;
    suspended = false;
    fit(): void {}
    focus(): void {}
    write(): void {}
    markExited(): void {}
    markSpawnFailed(): void {}
    markSuspended(): void {
      this.suspended = true;
    }
    attachPlaceholder(host: HTMLElement, opts?: { cliId?: string }): void {
      fake.placeholderCalls.push({ cliId: opts?.cliId });
      host.append(this.el);
      this.suspended = true;
    }
    setStartupCmdCallbacks(): void {}
    setCliRespawnCallbacks(): void {}
    setDockMenuCallbacks(): void {}
    setSuspendCallbacks(): void {}
    setShellCommandCallbacks(callbacks: { onCommand(command: string): void } | null): void {
      fake.panesByPtyId.set(this.ptyId, callbacks);
    }
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

vi.mock("./terminal-docking", () => ({
  attachTerminalDocking: vi.fn(() => ({ dispose: () => undefined })),
}));

vi.mock("./terminal-split-layout", () => ({
  layoutTerminalSplits: vi.fn(),
}));

import { TerminalManager } from "./terminal-manager";

function pid(id: string): ProjectId {
  return id as ProjectId;
}

function makeManager(opts?: {
  activeCliId?: string;
  layout?: TerminalLayoutNode;
}): TerminalManager {
  return new TerminalManager({
    projectId: pid("p1"),
    defaultCwd: "/tmp/project",
    activeCliId: opts?.activeCliId,
    layout: opts?.layout,
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

  it("seeds activeCliId from options when provided", async () => {
    const manager = makeManager({ activeCliId: "codex" });
    expect(manager.getActiveCli()).toBe("codex");

    await manager.addPane();

    expect(fake.attachCalls[0]?.opts?.command).toBe("codex");
  });

  it("respawnPane ignores re-entrant calls for the same ptyId", async () => {
    const manager = makeManager();
    await manager.addPane({ title: "x" });
    const [oldSpec] = manager.specs();
    if (!oldSpec) throw new Error("expected an initial spec");

    const first = manager.respawnPane(oldSpec.id, "claude");
    // Second call while the first is still in flight — must be a no-op.
    const second = manager.respawnPane(oldSpec.id, "codex");
    await Promise.all([first, second]);

    expect(manager.specs()).toHaveLength(1);
    expect(manager.specs()[0]?.cliId).toBe("claude");
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
    expect(terminalLayoutPaneIds(manager.layoutSnapshot)).toEqual(after);
  });

  it("docks live panes without attaching replacements", async () => {
    const manager = makeManager();
    await manager.addPane({ title: "a" });
    await manager.addPane({ title: "b" });
    const [firstId, secondId] = manager.ids();
    if (!firstId || !secondId) throw new Error("expected two panes");

    manager.dock(secondId, firstId, "bottom");

    expect(fake.attachCalls).toHaveLength(2);
    expect(manager.ids()).toEqual([firstId, secondId]);
    expect(manager.layoutSnapshot).toMatchObject({
      type: "split",
      axis: "column",
      first: { paneId: firstId },
      second: { paneId: secondId },
    });
  });

  it("collapses the layout after a pane closes", async () => {
    const manager = makeManager();
    await manager.addPane({ title: "a" });
    await manager.addPane({ title: "b" });
    const [firstId, secondId] = manager.ids();
    if (!firstId || !secondId) throw new Error("expected two panes");

    await manager.close(firstId);

    expect(manager.layoutSnapshot).toEqual({ type: "pane", paneId: secondId });
  });

  it("restores a persisted split by remapping regenerated PTY ids", async () => {
    const persistedLayout: TerminalLayoutNode = {
      type: "split",
      axis: "column",
      ratio: 0.7,
      first: { type: "pane", paneId: "old-a" },
      second: { type: "pane", paneId: "old-b" },
    };
    const manager = makeManager({ layout: persistedLayout });

    await manager.restoreSpecs([
      { id: "old-a", title: "a" },
      { id: "old-b", title: "b" },
    ]);

    expect(manager.ids()).toEqual(["pty-1", "pty-2"]);
    expect(manager.layoutSnapshot).toEqual({
      type: "split",
      axis: "column",
      ratio: 0.7,
      first: { type: "pane", paneId: "pty-1" },
      second: { type: "pane", paneId: "pty-2" },
    });
  });

  it("repairs a partial restored layout and includes each pane once", async () => {
    const partial = {
      type: "split",
      axis: "row",
      ratio: 0.5,
      first: { type: "pane", paneId: "old-a" },
      second: { type: "pane", paneId: "missing" },
    } as TerminalLayoutNode;
    const manager = makeManager({ layout: partial });

    await manager.restoreSpecs([{ id: "old-a" }, { id: "old-b" }]);

    expect(terminalLayoutPaneIds(manager.layoutSnapshot)).toEqual(["pty-1", "pty-2"]);
  });
});

describe("TerminalManager applyTemplate", () => {
  beforeEach(() => {
    fake.reset();
  });

  const template: LayoutTemplate = {
    id: "tpl",
    name: "claude + shell",
    specs: [
      { id: "tpl-a", cliId: "claude" },
      { id: "tpl-b", cliId: "shell", startupCmd: "pnpm dev" },
    ],
    layout: {
      type: "split",
      axis: "column",
      ratio: 0.6,
      first: { type: "pane", paneId: "tpl-a" },
      second: { type: "pane", paneId: "tpl-b" },
    },
  };

  it("spawns every spec into defaultCwd when no panes exist", async () => {
    const manager = makeManager();

    await manager.applyTemplate(template);

    expect(fake.attachCalls).toHaveLength(2);
    expect(fake.attachCalls.map((c) => c.opts?.cwd)).toEqual(["/tmp/project", "/tmp/project"]);
    expect(fake.attachCalls[0]?.opts?.command).toBe("claude");
    expect(manager.layoutSnapshot).toEqual({
      type: "split",
      axis: "column",
      ratio: 0.6,
      first: { type: "pane", paneId: "pty-1" },
      second: { type: "pane", paneId: "pty-2" },
    });
    const specs = manager.specs();
    expect(specs.map((s) => s.cliId)).toEqual(["claude", "shell"]);
    expect(specs[1]?.startupCmd).toBe("pnpm dev");
  });

  it("reuses an existing pane with a matching cliId and only spawns the rest", async () => {
    const manager = makeManager();
    await manager.addPane({ cliId: "claude" });

    await manager.applyTemplate(template);

    expect(fake.attachCalls).toHaveLength(2);
    expect(manager.layoutSnapshot).toEqual({
      type: "split",
      axis: "column",
      ratio: 0.6,
      first: { type: "pane", paneId: "pty-1" },
      second: { type: "pane", paneId: "pty-2" },
    });
  });

  it("keeps panes the template does not consume, appended after the tree", async () => {
    const manager = makeManager();
    await manager.addPane({ cliId: "codex" });

    await manager.applyTemplate(template);

    expect(terminalLayoutPaneIds(manager.layoutSnapshot)).toEqual(["pty-2", "pty-3", "pty-1"]);
    expect(manager.specs().map((s) => s.cliId)).toEqual(["claude", "shell", "codex"]);
  });
});

describe("TerminalManager suspend/resume", () => {
  beforeEach(() => {
    fake.reset();
  });

  it("suspendPane kills the pty, flags the spec, and keeps the pane mounted", async () => {
    const manager = makeManager();
    await manager.addPane({ cliId: "claude" });
    const [id] = manager.ids();

    manager.suspendPane(id);

    const { ptyKill } = await import("./pty-client");
    expect(ptyKill).toHaveBeenCalledWith(id);
    expect(manager.specs()[0]?.suspended).toBe(true);
    expect(manager.ids()).toEqual([id]);
    expect(manager.size).toBe(1);
    manager.markExited(id);
    expect(manager.size).toBe(0);
  });

  it("resumePane respawns with the profile's resumeArgs in the same slot", async () => {
    const manager = makeManager();
    await manager.addPane({ cliId: "shell" });
    await manager.addPane({ cliId: "claude", startupCmd: "echo hi" });
    await manager.addPane({ cliId: "shell" });
    const suspendedId = manager.ids()[1];

    manager.suspendPane(suspendedId);
    manager.markExited(suspendedId);
    await manager.resumePane(suspendedId);

    const lastAttach = fake.attachCalls[fake.attachCalls.length - 1];
    expect(lastAttach?.opts?.command).toBe("claude");
    expect(lastAttach?.opts?.args).toEqual(["--continue"]);
    expect(manager.ids()[1]).toBe(lastAttach?.ptyId);
    expect(manager.specs()[1]?.suspended).toBeUndefined();
    expect(manager.specs()[1]?.startupCmd).toBe("echo hi");
  });

  it("resumePane is a no-op for live or unknown panes", async () => {
    const manager = makeManager();
    await manager.addPane({ cliId: "claude" });
    const [id] = manager.ids();
    const before = fake.attachCalls.length;

    await manager.resumePane(id);
    await manager.resumePane("ghost");

    expect(fake.attachCalls.length).toBe(before);
  });

  it("suspendAll only touches live panes", async () => {
    const manager = makeManager();
    await manager.addPane({ cliId: "claude" });
    await manager.addPane({ cliId: "codex" });
    const [a, b] = manager.ids();
    manager.suspendPane(a);
    manager.markExited(a);

    manager.suspendAll();

    expect(manager.specs().map((s) => s.suspended)).toEqual([true, true]);
    manager.markExited(b);
    expect(manager.size).toBe(0);
  });

  it("restoreSpecs mounts suspended specs as placeholders without spawning", async () => {
    const manager = makeManager();

    await manager.restoreSpecs([
      { id: "old-live", cliId: "shell" },
      { id: "old-suspended", cliId: "claude", suspended: true },
    ]);

    expect(fake.attachCalls).toHaveLength(1);
    expect(fake.placeholderCalls).toEqual([{ cliId: "claude" }]);
    expect(manager.ids()).toEqual(["pty-1", "old-suspended"]);
    expect(manager.size).toBe(1);
    expect(terminalLayoutPaneIds(manager.layoutSnapshot)).toContain("old-suspended");
  });
});

describe("TerminalManager resumeAll / shell command replay", () => {
  beforeEach(async () => {
    fake.reset();
    vi.useFakeTimers();
    const { ptyWrite } = await import("./pty-client");
    vi.mocked(ptyWrite).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resumePane replays the captured lastShellCommand for a shell profile", async () => {
    const manager = makeManager();
    await manager.addPane({ cliId: "shell" });
    const [id] = manager.ids();
    fake.emitShellCommand(id, "npm run dev");
    expect(manager.specs()[0]?.lastShellCommand).toBe("npm run dev");

    manager.suspendPane(id);
    manager.markExited(id);
    await manager.resumePane(id);
    const newId = manager.ids()[0];
    await vi.advanceTimersByTimeAsync(1000);

    const { ptyWrite } = await import("./pty-client");
    expect(ptyWrite).toHaveBeenCalledWith(newId, "npm run dev\r");
  });

  it("resumePane does not replay anything when no command was captured", async () => {
    const manager = makeManager();
    await manager.addPane({ cliId: "shell" });
    const [id] = manager.ids();

    manager.suspendPane(id);
    manager.markExited(id);
    await manager.resumePane(id);
    await vi.advanceTimersByTimeAsync(1000);

    const { ptyWrite } = await import("./pty-client");
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("resumeAll resumes every suspended pane and skips live ones", async () => {
    const manager = makeManager();
    await manager.addPane({ cliId: "shell" }); // will be suspended, with a command
    await manager.addPane({ cliId: "claude" }); // will be suspended
    await manager.addPane({ cliId: "shell" }); // stays live
    const [shellId, claudeId, liveShellId] = manager.ids();
    fake.emitShellCommand(shellId, "npm test");

    manager.suspendPane(shellId);
    manager.markExited(shellId);
    manager.suspendPane(claudeId);
    manager.markExited(claudeId);

    await manager.resumeAll();
    await vi.advanceTimersByTimeAsync(1000);

    expect(manager.specs().every((s) => !s.suspended)).toBe(true);
    const lastClaudeAttach = [...fake.attachCalls]
      .reverse()
      .find((c) => c.opts?.command === "claude");
    expect(lastClaudeAttach?.opts?.args).toEqual(["--continue"]);
    const { ptyWrite } = await import("./pty-client");
    expect(vi.mocked(ptyWrite).mock.calls).toContainEqual([expect.any(String), "npm test\r"]);
    // The still-live shell pane was never touched.
    expect(manager.ids()).toContain(liveShellId);
  });

  it("resumeAll resumes multiple suspended panes sequentially without corrupting the layout", async () => {
    // Regression: concurrent resumePane calls used to stomp on each other's layout snapshot.
    const manager = makeManager();
    await manager.addPane({ cliId: "shell", title: "one" });
    await manager.addPane({ cliId: "shell", title: "two" });
    await manager.addPane({ cliId: "shell", title: "three" });
    const [a, b, c] = manager.ids();

    manager.suspendPane(a);
    manager.markExited(a);
    manager.suspendPane(b);
    manager.markExited(b);
    manager.suspendPane(c);
    manager.markExited(c);

    await manager.resumeAll();
    await vi.advanceTimersByTimeAsync(1000);

    expect(manager.specs()).toHaveLength(3);
    expect(manager.specs().every((s) => !s.suspended)).toBe(true);
    // Distinct entries in both order and layout, not collapsed to one pane.
    expect(manager.ids()).toHaveLength(3);
    expect(new Set(manager.ids()).size).toBe(3);
    expect(terminalLayoutPaneIds(manager.layoutSnapshot).sort()).toEqual([...manager.ids()].sort());
  });
});

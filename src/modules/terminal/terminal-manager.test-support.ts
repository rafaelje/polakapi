import { vi } from "vitest";
import type { PaneCreateOptions } from "./types";

const fake = vi.hoisted(() => {
  const attachCalls: Array<{ opts: PaneCreateOptions | undefined; ptyId: string }> = [];
  const placeholderCalls: Array<{ cliId?: string }> = [];
  const panesByPtyId = new Map<
    string,
    { onCommand(command: string, isAlias: boolean): void } | null
  >();
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
    emitShellCommand(ptyId: string, command: string, isAlias = false): void {
      panesByPtyId.get(ptyId)?.onCommand(command, isAlias);
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
    setShellCommandCallbacks(
      callbacks: { onCommand(command: string, isAlias: boolean): void } | null,
    ): void {
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

export const terminalManagerFixture = fake;

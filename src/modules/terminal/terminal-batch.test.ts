import { describe, expect, it, vi } from "vitest";
import {
  busyMessage,
  busyPanes,
  closeAllPanes,
  reloadAllPanes,
  reloadSpec,
  type BatchTarget,
} from "./terminal-batch";
import type { TerminalSpec } from "./types";

vi.mock("../../shared/tauri/invoke", () => ({ invoke: vi.fn() }));

function fakeTarget(specs: TerminalSpec[]): {
  target: BatchTarget;
  closed: Array<{ id: string; silent: boolean }>;
  added: Array<Partial<TerminalSpec>>;
} {
  let live = [...specs];
  const closed: Array<{ id: string; silent: boolean }> = [];
  const added: Array<Partial<TerminalSpec>> = [];
  const target: BatchTarget = {
    ids: () => live.map((spec) => spec.id),
    specs: () => [...live],
    isLive: () => true,
    close: (id, opts) => {
      closed.push({ id, silent: opts?.silent === true });
      live = live.filter((spec) => spec.id !== id);
      return Promise.resolve();
    },
    addPane: (spec) => {
      added.push(spec ?? {});
      return Promise.resolve(null);
    },
  };
  return { target, closed, added };
}

const spec = (patch: Partial<TerminalSpec> & { id: string }): TerminalSpec => ({
  cliId: "shell",
  ...patch,
});

describe("busyPanes", () => {
  it("labels busy panes by their position", () => {
    const busy = busyPanes(
      ["a", "b", "c"],
      [
        { ptyId: "c", command: "npm" },
        { ptyId: "a", command: "cargo" },
      ],
    );
    expect(busy).toEqual([
      { label: "pane 1", command: "cargo" },
      { label: "pane 3", command: "npm" },
    ]);
  });

  it("is empty when nothing is running", () => {
    expect(busyPanes(["a", "b"], [])).toEqual([]);
  });

  it("ignores processes belonging to other projects' panes", () => {
    expect(busyPanes(["a"], [{ ptyId: "zz", command: "npm" }])).toEqual([]);
  });
});

describe("busyMessage", () => {
  it("uses the singular for one pane", () => {
    expect(busyMessage([{ label: "pane 1", command: "npm" }])).toBe(
      "1 terminal is still running something:\n• pane 1: npm",
    );
  });

  it("lists every busy pane", () => {
    const message = busyMessage([
      { label: "pane 1", command: "npm" },
      { label: "pane 2", command: "cargo" },
    ]);
    expect(message).toContain("2 terminals are still running something:");
    expect(message).toContain("• pane 2: cargo");
  });
});

describe("reloadSpec", () => {
  it("keeps where and what, drops the resume arguments", () => {
    expect(
      reloadSpec(
        spec({
          id: "p1",
          cwd: "/repo",
          cliId: "claude",
          title: "agent",
          startupCmd: "echo hi",
          launchArgs: ["--continue"],
          lastShellCommand: "ls",
          suspended: true,
        }),
      ),
    ).toEqual({ cwd: "/repo", cliId: "claude", title: "agent", startupCmd: "echo hi" });
  });
});

describe("closeAllPanes", () => {
  it("closes every pane", async () => {
    const { target, closed } = fakeTarget([spec({ id: "a" }), spec({ id: "b" })]);
    await closeAllPanes(target);
    expect(closed.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(target.ids()).toEqual([]);
  });
});

describe("reloadAllPanes", () => {
  it("closes each pane and reopens it from the snapshot", async () => {
    const { target, closed, added } = fakeTarget([
      spec({ id: "a", cwd: "/one", cliId: "claude", launchArgs: ["--continue"] }),
      spec({ id: "b", cwd: "/two" }),
    ]);
    await reloadAllPanes(target);

    expect(closed.map((entry) => entry.id)).toEqual(["a", "b"]);
    // Silent closes: the batch relayouts once as the panes come back.
    expect(closed.every((entry) => entry.silent)).toBe(true);
    expect(added).toEqual([
      { cwd: "/one", cliId: "claude", title: undefined, startupCmd: undefined },
      { cwd: "/two", cliId: "shell", title: undefined, startupCmd: undefined },
    ]);
  });

  it("reopens as many panes as it closed", async () => {
    const { target, added } = fakeTarget([spec({ id: "a" }), spec({ id: "b" }), spec({ id: "c" })]);
    await reloadAllPanes(target);
    expect(added).toHaveLength(3);
  });

  it("does nothing when the project has no terminals", async () => {
    const { target, closed, added } = fakeTarget([]);
    await reloadAllPanes(target);
    expect(closed).toEqual([]);
    expect(added).toEqual([]);
  });
});

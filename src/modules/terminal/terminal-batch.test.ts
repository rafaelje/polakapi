import { describe, expect, it, vi } from "vitest";
import {
  busyMessage,
  busyPanes,
  closeAllPanes,
  reloadAllPanes,
  reloadSpec,
  reloadTemplate,
  type BatchTarget,
} from "./terminal-batch";
import type { TerminalLayoutNode } from "./terminal-layout";
import type { LayoutTemplate } from "../workspaces/state/types";
import type { TerminalSpec } from "./types";

vi.mock("../../shared/tauri/invoke", () => ({ invoke: vi.fn() }));

function fakeTarget(
  specs: TerminalSpec[],
  layout: TerminalLayoutNode | null = null,
): {
  target: BatchTarget;
  closed: Array<{ id: string; silent: boolean }>;
  added: Array<Partial<TerminalSpec>>;
  applied: LayoutTemplate[];
} {
  let live = [...specs];
  const closed: Array<{ id: string; silent: boolean }> = [];
  const added: Array<Partial<TerminalSpec>> = [];
  const applied: LayoutTemplate[] = [];
  const target: BatchTarget = {
    layoutSnapshot: layout,
    applyTemplate: (template) => {
      applied.push(template);
      return Promise.resolve();
    },
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
  return { target, closed, added, applied };
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

const twoPaneTree: TerminalLayoutNode = {
  type: "split",
  axis: "row",
  ratio: 0.25,
  first: { type: "pane", paneId: "a" },
  second: { type: "pane", paneId: "b" },
};

describe("reloadTemplate", () => {
  it("captures the tree untouched and every pane's directory", () => {
    const template = reloadTemplate(
      [
        spec({ id: "a", cwd: "/one", cliId: "claude", launchArgs: ["--continue"] }),
        spec({ id: "b", cwd: "/two", title: "logs" }),
      ],
      twoPaneTree,
    );
    expect(template?.layout).toEqual(twoPaneTree);
    expect(template?.specs).toEqual([
      { id: "a", cliId: "claude", cwd: "/one" },
      { id: "b", cliId: "shell", title: "logs", cwd: "/two" },
    ]);
  });

  it("never carries the resume arguments", () => {
    const template = reloadTemplate(
      [spec({ id: "a", launchArgs: ["--continue"] }), spec({ id: "b" })],
      twoPaneTree,
    );
    expect(template?.specs.every((entry) => !("launchArgs" in entry))).toBe(true);
  });

  it("has nothing to capture without a tree", () => {
    expect(reloadTemplate([spec({ id: "a" })], null)).toBeNull();
  });
});

describe("reloadAllPanes", () => {
  it("restores the captured arrangement instead of appending panes", async () => {
    const { target, closed, added, applied } = fakeTarget(
      [spec({ id: "a", cwd: "/one" }), spec({ id: "b", cwd: "/two" })],
      twoPaneTree,
    );
    await reloadAllPanes(target);

    expect(closed).toEqual([
      { id: "a", silent: true },
      { id: "b", silent: true },
    ]);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.layout).toEqual(twoPaneTree);
    expect(applied[0]?.specs.map((entry) => entry.cwd)).toEqual(["/one", "/two"]);
    expect(added).toEqual([]);
  });

  it("without a tree, reopens the panes in order", async () => {
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

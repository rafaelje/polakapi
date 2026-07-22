import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/tauri/invoke", () => ({ invoke: vi.fn() }));
vi.mock("../../shared/ui/toast", () => ({ showToast: vi.fn() }));

import {
  formatMemoryIndicator,
  planIdleSuspensions,
  planMemoryRelief,
  type LivePane,
  type PaneMemory,
} from "./memory-guard";

function pane(paneId: string, projectId: string, rssMb: number): PaneMemory {
  return { paneId, projectId, rssMb, lastActivityAt: 0 };
}

function livePane(
  paneId: string,
  projectId: string,
  cliId: string | undefined,
  lastActivityAt: number,
): LivePane {
  return { paneId, projectId, cliId, lastActivityAt };
}

describe("planMemoryRelief", () => {
  const panes = [
    pane("a", "p1", 400),
    pane("b", "p2", 300),
    pane("c", "p2", 100),
    pane("d", "p3", 200),
  ];

  it("returns no suspensions while under the limit", () => {
    expect(planMemoryRelief(panes, 2000, "p1")).toEqual({ suspend: [], usedMb: 1000 });
  });

  it("suspends heaviest background panes first until under the limit", () => {
    const { suspend, usedMb } = planMemoryRelief(panes, 600, "p1");
    expect(usedMb).toBe(1000);
    expect(suspend.map((p) => p.paneId)).toEqual(["b", "d"]);
  });

  it("never suspends panes of the active project", () => {
    const { suspend } = planMemoryRelief(panes, 100, "p1");
    expect(suspend.map((p) => p.paneId)).toEqual(["b", "d", "c"]);
    expect(suspend.some((p) => p.projectId === "p1")).toBe(false);
  });

  it("is a no-op when the limit is disabled (0)", () => {
    expect(planMemoryRelief(panes, 0, null).suspend).toEqual([]);
  });

  it("returns empty suspensions when the overage is all in the active project", () => {
    const only = [pane("a", "p1", 900)];
    const { suspend, usedMb } = planMemoryRelief(only, 500, "p1");
    expect(suspend).toEqual([]);
    expect(usedMb).toBe(900);
  });
});

describe("planIdleSuspensions", () => {
  const NOW = 100 * 60_000;
  const LIMIT = 30 * 60_000;
  const panes = [
    livePane("ai-idle", "p2", "claude", NOW - 31 * 60_000),
    livePane("ai-fresh", "p2", "codex", NOW - 5 * 60_000),
    livePane("shell-idle", "p2", "shell", NOW - 90 * 60_000),
    livePane("shell-implicit", "p2", undefined, NOW - 90 * 60_000),
    livePane("ai-active-project", "p1", "claude", NOW - 90 * 60_000),
  ];

  it("suspends only idle AI panes of background projects", () => {
    const idle = planIdleSuspensions(panes, LIMIT, "p1", NOW);
    expect(idle.map((p) => p.paneId)).toEqual(["ai-idle"]);
  });

  it("never touches shells, even long-idle ones", () => {
    const idle = planIdleSuspensions(panes, LIMIT, null, NOW);
    expect(idle.map((p) => p.paneId)).toEqual(["ai-idle", "ai-active-project"]);
  });

  it("is a no-op when disabled (0)", () => {
    expect(planIdleSuspensions(panes, 0, "p1", NOW)).toEqual([]);
  });

  it("treats the threshold as inclusive", () => {
    const exact = [livePane("a", "p2", "claude", NOW - LIMIT)];
    expect(planIdleSuspensions(exact, LIMIT, "p1", NOW)).toHaveLength(1);
  });
});

describe("formatMemoryIndicator", () => {
  it("shows usage vs limit in GB", () => {
    expect(formatMemoryIndicator(3172, 9830)).toBe("RAM 3.1/9.6G");
  });

  it("omits the limit when disabled", () => {
    expect(formatMemoryIndicator(512, 0)).toBe("RAM 0.5G");
  });
});

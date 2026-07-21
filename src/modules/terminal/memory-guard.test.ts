import { describe, expect, it, vi } from "vitest";

vi.mock("../../shared/tauri/invoke", () => ({ invoke: vi.fn() }));
vi.mock("../../shared/ui/toast", () => ({ showToast: vi.fn() }));

import { formatMemoryIndicator, planMemoryRelief, type PaneMemory } from "./memory-guard";

function pane(paneId: string, projectId: string, rssMb: number): PaneMemory {
  return { paneId, projectId, rssMb };
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
    // 1000 - 300 (b) = 700 > 600 → also d: 700 - 200 = 500 <= 600.
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

describe("formatMemoryIndicator", () => {
  it("shows usage vs limit in GB", () => {
    expect(formatMemoryIndicator(3172, 9830)).toBe("RAM 3.1/9.6G");
  });

  it("omits the limit when disabled", () => {
    expect(formatMemoryIndicator(512, 0)).toBe("RAM 0.5G");
  });
});

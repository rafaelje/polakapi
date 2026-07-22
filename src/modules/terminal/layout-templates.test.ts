import { describe, expect, it } from "vitest";

import { buildLayoutTemplate, planTemplateApplication } from "./layout-templates";
import type { TerminalLayoutNode } from "./terminal-layout";
import type { TerminalSpec } from "./types";

const LAYOUT: TerminalLayoutNode = {
  type: "split",
  axis: "column",
  ratio: 0.3,
  first: { type: "pane", paneId: "a" },
  second: { type: "pane", paneId: "b" },
};

describe("buildLayoutTemplate", () => {
  const specs: TerminalSpec[] = [
    { id: "b", cliId: "codex", cwd: "/somewhere/else", startupCmd: "pnpm dev" },
    { id: "a", cliId: "claude", cwd: "/original/project", title: "main" },
  ];

  it("strips cwd and orders specs by layout position", () => {
    const template = buildLayoutTemplate("My layout", specs, LAYOUT);
    expect(template?.specs).toEqual([
      { id: "a", cliId: "claude", title: "main" },
      { id: "b", cliId: "codex", startupCmd: "pnpm dev" },
    ]);
    expect(template?.layout).toBe(LAYOUT);
    expect(template?.name).toBe("My layout");
  });

  it("returns null for empty name, missing layout, or no matching panes", () => {
    expect(buildLayoutTemplate("  ", specs, LAYOUT)).toBeNull();
    expect(buildLayoutTemplate("x", specs, null)).toBeNull();
    expect(buildLayoutTemplate("x", [], LAYOUT)).toBeNull();
  });
});

describe("planTemplateApplication", () => {
  it("reuses live panes by cliId first-come and spawns the rest", () => {
    const steps = planTemplateApplication(
      [
        { id: "t1", cliId: "claude" },
        { id: "t2", cliId: "claude" },
        { id: "t3", cliId: "shell" },
      ],
      [
        { id: "live-1", cliId: "claude" },
        { id: "live-2", cliId: "codex" },
      ],
    );
    expect(steps).toEqual([
      { specId: "t1", action: "reuse", paneId: "live-1" },
      { specId: "t2", action: "spawn", spec: { id: "t2", cliId: "claude" } },
      { specId: "t3", action: "spawn", spec: { id: "t3", cliId: "shell" } },
    ]);
  });

  it("treats undefined cliId as shell on both sides", () => {
    const steps = planTemplateApplication([{ id: "t1" }], [{ id: "live-1", cliId: "shell" }]);
    expect(steps).toEqual([{ specId: "t1", action: "reuse", paneId: "live-1" }]);
  });

  it("leaves live panes not consumed by the template untouched", () => {
    const steps = planTemplateApplication(
      [{ id: "t1", cliId: "shell" }],
      [
        { id: "live-1", cliId: "shell" },
        { id: "live-2", cliId: "claude" },
      ],
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ specId: "t1", action: "reuse", paneId: "live-1" });
  });
});

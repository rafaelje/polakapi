import { describe, expect, it } from "vitest";
import {
  contextBar,
  contextLevel,
  contextPercent,
  fileSummary,
  formatCost,
  formatCpu,
  formatRam,
  formatTokens,
  formatUptime,
  groupByProject,
  shortModel,
  toolSummary,
} from "./format";
import type { ContextRow, PaneContext } from "./types";
import type { ProjectId } from "../workspaces/state/types";

const projectId = (value: string): ProjectId => value as ProjectId;

function context(patch: Partial<PaneContext> = {}): PaneContext {
  return {
    ptyId: "p1",
    source: "claude",
    model: "claude-opus-5",
    contextTokens: 0,
    contextLimit: 200_000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: null,
    turns: 0,
    tools: [],
    files: [],
    sessionId: null,
    rssMb: 0,
    cpuPercent: 0,
    uptimeSecs: 0,
    pid: null,
    ...patch,
  };
}

describe("formatTokens", () => {
  it("keeps small counts exact and abbreviates larger ones", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(118_000)).toBe("118k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
  });

  it("treats non-finite and negative input as zero", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("contextPercent", () => {
  it("computes a clamped percentage", () => {
    expect(contextPercent(100_000, 200_000)).toBe(50);
    expect(contextPercent(300_000, 200_000)).toBe(100);
  });

  it("returns zero when the limit is unknown", () => {
    expect(contextPercent(1_000, 0)).toBe(0);
  });
});

describe("contextBar", () => {
  it("fills proportionally to the width", () => {
    expect(contextBar(0, 10)).toBe("░░░░░░░░░░");
    expect(contextBar(50, 10)).toBe("█████░░░░░");
    expect(contextBar(100, 10)).toBe("██████████");
  });

  it("never exceeds the requested width", () => {
    expect(contextBar(140, 10)).toHaveLength(10);
  });
});

describe("contextLevel", () => {
  it("bands the percentage", () => {
    expect(contextLevel(10)).toBe("ok");
    expect(contextLevel(60)).toBe("warn");
    expect(contextLevel(85)).toBe("high");
  });
});

describe("process formatters", () => {
  it("switches RAM to GB past 1024 MB", () => {
    expect(formatRam(412)).toBe("412 MB");
    expect(formatRam(2_048)).toBe("2.0 GB");
    expect(formatRam(0)).toBe("0 MB");
  });

  it("keeps one decimal for low CPU only", () => {
    expect(formatCpu(0)).toBe("0%");
    expect(formatCpu(2.4)).toBe("2.4%");
    expect(formatCpu(34)).toBe("34%");
  });

  it("formats uptime by magnitude", () => {
    expect(formatUptime(0)).toBe("—");
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(200)).toBe("3m");
    expect(formatUptime(3_700)).toBe("1h 1m");
    expect(formatUptime(90_000)).toBe("1d 1h");
  });

  it("hides zero and sub-cent cost distinctly", () => {
    expect(formatCost(null)).toBeNull();
    expect(formatCost(0)).toBeNull();
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(1.5)).toBe("$1.50");
  });
});

describe("shortModel", () => {
  it("strips the vendor prefix and date suffix", () => {
    expect(shortModel("claude-opus-5")).toBe("opus-5");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
    expect(shortModel(null)).toBeNull();
  });
});

describe("summaries", () => {
  it("joins the busiest tools", () => {
    expect(
      toolSummary(
        context({
          tools: [
            { name: "Read", count: 9 },
            { name: "Edit", count: 3 },
          ],
        }),
      ),
    ).toBe("Read·Edit");
    expect(toolSummary(context())).toBeNull();
  });

  it("counts the files it does not show", () => {
    expect(fileSummary(context({ files: ["a.ts", "b.ts", "c.ts"] }), 2)).toBe("a.ts, b.ts +1");
    expect(fileSummary(context({ files: ["a.ts"] }), 2)).toBe("a.ts");
    expect(fileSummary(context())).toBeNull();
  });
});

describe("groupByProject", () => {
  const row = (ptyId: string, project: string): ContextRow => ({
    ptyId,
    projectId: projectId(project),
    label: ptyId,
    cliId: "claude",
    lastActivityAt: 0,
    context: null,
  });

  it("groups rows preserving first-seen project order", () => {
    const names = new Map([
      [projectId("a"), "polakapi"],
      [projectId("b"), "simple-c"],
    ]);
    const groups = groupByProject([row("1", "a"), row("2", "b"), row("3", "a")], names);
    expect(groups.map((g) => g.projectName)).toEqual(["polakapi", "simple-c"]);
    expect(groups[0].rows.map((r) => r.ptyId)).toEqual(["1", "3"]);
  });

  it("falls back to a placeholder name for unknown projects", () => {
    const groups = groupByProject([row("1", "ghost")], new Map());
    expect(groups[0].projectName).toBe("unknown project");
  });

  it("returns nothing when there are no live panes", () => {
    expect(groupByProject([], new Map())).toEqual([]);
  });
});

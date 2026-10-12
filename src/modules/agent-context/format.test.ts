import { describe, expect, it } from "vitest";
import {
  breakdownRows,
  contextBar,
  contextLabel,
  contextLevel,
  contextPercent,
  isSortMode,
  sortEntries,
  formatBytes,
  formatClock,
  formatCpu,
  formatRam,
  formatTokens,
  formatUptime,
  kindLabel,
  shortModel,
} from "./format";
import type { ContextBreakdown, ContextEntry } from "./types";

const breakdown = (patch: Partial<ContextBreakdown> = {}): ContextBreakdown => ({
  instructions: 0,
  files: 0,
  toolOutput: 0,
  messages: 0,
  thinking: 0,
  ...patch,
});

describe("formatTokens", () => {
  it("keeps small counts exact and abbreviates larger ones", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(118_000)).toBe("118k");
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });

  it("treats non-finite and negative input as zero", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("formatBytes", () => {
  it("scales by magnitude", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("contextPercent", () => {
  it("computes a clamped percentage", () => {
    expect(contextPercent(100_000, 200_000)).toBe(50);
    expect(contextPercent(300_000, 200_000)).toBe(100);
    expect(contextPercent(250_000, 1_000_000)).toBe(25);
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
});

describe("shortModel", () => {
  it("strips the vendor prefix and date suffix", () => {
    expect(shortModel("claude-opus-5")).toBe("opus-5");
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
    expect(shortModel(null)).toBeNull();
  });
});

describe("kindLabel", () => {
  it("gives every entry kind a human label", () => {
    expect(kindLabel("instructions")).toBe("injected");
    expect(kindLabel("user-prompt")).toBe("you");
    expect(kindLabel("file-content")).toBe("file");
    expect(kindLabel("tool-output")).toBe("output");
  });
});

describe("breakdownRows", () => {
  it("sorts by weight and shares out the percentage", () => {
    const rows = breakdownRows(breakdown({ files: 60, messages: 30, instructions: 10 }));
    expect(rows.map((row) => row.key)).toEqual([
      "files",
      "messages",
      "instructions",
      "toolOutput",
      "thinking",
    ]);
    expect(rows[0].percent).toBe(60);
    expect(rows[1].percent).toBe(30);
  });

  it("keeps empty buckets so a missing category is visible", () => {
    const rows = breakdownRows(breakdown({ messages: 5 }));
    expect(rows).toHaveLength(5);
    expect(rows.find((row) => row.key === "files")?.tokens).toBe(0);
  });

  it("reports zero percent rather than dividing by zero", () => {
    expect(breakdownRows(breakdown()).every((row) => row.percent === 0)).toBe(true);
  });
});

describe("sortEntries", () => {
  const entry = (id: number, estTokens: number): ContextEntry => ({
    id,
    kind: "user-prompt",
    label: "user",
    detail: null,
    timestamp: null,
    chars: estTokens * 4,
    estTokens,
    preview: "",
    truncated: false,
  });
  const entries = [entry(0, 50), entry(1, 200), entry(2, 10)];

  it("defaults to transcript order", () => {
    expect(sortEntries(entries, "oldest").map((e) => e.id)).toEqual([0, 1, 2]);
  });

  it("reverses for newest first", () => {
    expect(sortEntries(entries, "newest").map((e) => e.id)).toEqual([2, 1, 0]);
  });

  it("sorts by size in both directions", () => {
    expect(sortEntries(entries, "largest").map((e) => e.id)).toEqual([1, 0, 2]);
    expect(sortEntries(entries, "smallest").map((e) => e.id)).toEqual([2, 0, 1]);
  });

  it("does not mutate the input", () => {
    const original = [...entries];
    sortEntries(entries, "newest");
    expect(entries).toEqual(original);
  });

  it("breaks size ties by transcript order", () => {
    const tied = [entry(2, 7), entry(0, 7), entry(1, 7)];
    expect(sortEntries(tied, "largest").map((e) => e.id)).toEqual([0, 1, 2]);
  });
});

describe("isSortMode", () => {
  it("accepts only the known modes", () => {
    expect(isSortMode("oldest")).toBe(true);
    expect(isSortMode("largest")).toBe(true);
    expect(isSortMode("sideways")).toBe(false);
  });
});

describe("contextLabel", () => {
  it("shows a percentage only when the window size is known", () => {
    expect(contextLabel(312_000, 1_000_000)).toBe("312k / 1.0M (31%)");
  });

  it("refuses to invent a denominator", () => {
    expect(contextLabel(4_200, 0)).toBe("4.2k · window size unknown");
    expect(contextLabel(0, 0)).toBe("no token data");
  });
});

describe("formatClock", () => {
  it("renders hours and minutes", () => {
    expect(formatClock("2026-09-15T14:02:00.000Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("is empty for missing or unparseable input", () => {
    expect(formatClock(null)).toBe("");
    expect(formatClock("not a date")).toBe("");
  });
});

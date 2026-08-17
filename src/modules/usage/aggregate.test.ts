import { describe, expect, it } from "vitest";
import { formatTokens, sumLastDays } from "./aggregate";
import type { DailyBucket } from "./types";

const bucket = (date: string, claudeTotal: number, codexTotal: number): DailyBucket => ({
  date,
  claude: {
    input: claudeTotal,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: claudeTotal,
  },
  codex: {
    input: codexTotal,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: codexTotal,
  },
});

describe("sumLastDays", () => {
  const buckets: DailyBucket[] = [
    bucket("2026-08-16", 100, 10),
    bucket("2026-08-15", 200, 20),
    bucket("2026-08-14", 400, 40),
    bucket("2026-08-13", 800, 80),
  ];

  it("returns zeros when days <= 0", () => {
    expect(sumLastDays(buckets, 0, (b) => b.claude).total).toBe(0);
  });

  it("sums claude tokens across the requested window", () => {
    expect(sumLastDays(buckets, 2, (b) => b.claude).total).toBe(300);
    expect(sumLastDays(buckets, 7, (b) => b.claude).total).toBe(1500);
  });

  it("sums codex tokens independently", () => {
    expect(sumLastDays(buckets, 3, (b) => b.codex).total).toBe(70);
  });
});

describe("formatTokens", () => {
  it("formats sub-thousand values as integers", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(9)).toBe("9");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands and millions with adaptive precision", () => {
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(1_500_000)).toBe("1.50M");
    expect(formatTokens(25_000_000)).toBe("25.0M");
  });
});

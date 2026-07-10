import { describe, expect, it } from "vitest";

import { computeVerdict, renderReport } from "./report";
import type { DebateState, Finding, FindingLedger, FindingStatus } from "../types";

function mkFinding(id: string, status: FindingStatus, severity: Finding["severity"]): Finding {
  return {
    id,
    file: "src/foo.ts",
    line: 10,
    severity,
    claim: `claim ${id}`,
    status,
    history: [
      { round: 1, role: "critic", action: "new", argument: `critic ${id}` },
      { round: 1, role: "defender", action: "concede", argument: `defender ${id}` },
    ],
  };
}

function ledger(findings: Finding[]): FindingLedger {
  return { findings, appliedPasses: [] };
}

describe("computeVerdict", () => {
  it("APPROVED when only sub-threshold confirmed findings exist", () => {
    const summary = computeVerdict(ledger([mkFinding("F1", "confirmed", "minor")]), "major");
    expect(summary.verdict).toBe("APPROVED");
    expect(summary.confirmedBlocking).toHaveLength(0);
    expect(summary.confirmedNonBlocking).toHaveLength(1);
  });

  it("CHANGES REQUESTED when a confirmed finding is at/above threshold", () => {
    const summary = computeVerdict(ledger([mkFinding("F1", "confirmed", "major")]), "major");
    expect(summary.verdict).toBe("CHANGES REQUESTED");
    expect(summary.confirmedBlocking).toHaveLength(1);
  });

  it("APPROVED when only disputed findings remain", () => {
    const summary = computeVerdict(ledger([mkFinding("F1", "disputed", "critical")]), "major");
    expect(summary.verdict).toBe("APPROVED");
    expect(summary.disputed).toHaveLength(1);
  });

  it("counts withdrawn findings separately", () => {
    const summary = computeVerdict(
      ledger([mkFinding("F1", "withdrawn", "major"), mkFinding("F2", "confirmed", "critical")]),
      "major",
    );
    expect(summary.withdrawnCount).toBe(1);
    expect(summary.verdict).toBe("CHANGES REQUESTED");
  });
});

describe("renderReport", () => {
  it("emits deterministic markdown for a simple ledger", () => {
    const state: DebateState = {
      status: "completed",
      settings: {
        projectPath: "/home/dev/thing",
        runId: "run-x",
        baseRef: "main",
        mergeBase: "abc123456",
        headSha: "def7890abc",
        rounds: 2,
        critic: { cli: "claude", model: "claude-opus-4-7", effort: "default" },
        defender: { cli: "codex", model: "gpt-5", effort: "high" },
        blockingSeverity: "major",
        timeoutSecs: 600,
        scopePaths: [],
        diffMode: "committed",
      },
      passes: [],
      findings: ledger([
        mkFinding("F1", "confirmed", "critical"),
        mkFinding("F2", "disputed", "minor"),
        mkFinding("F3", "withdrawn", "major"),
      ]),
      totals: { tokensIn: 1234, tokensOut: 567, costUsd: 0.0421 },
      lastHeartbeat: 0,
      diffTruncated: false,
    };
    const md = renderReport(state);
    expect(md).toMatch(/CHANGES REQUESTED/);
    expect(md).toMatch(/### F1 `critical`/);
    expect(md).toMatch(/### F2 `minor`/);
    expect(md).toMatch(/\bF3\b/);
    expect(md).toMatch(/\$0\.0421/);
  });

  it("shows the scope paths in the header when the diff was scoped", () => {
    const state: DebateState = {
      status: "completed",
      settings: {
        projectPath: "/x",
        runId: "r",
        baseRef: "main",
        mergeBase: "a",
        headSha: "b",
        rounds: 1,
        critic: { cli: "claude", model: "c", effort: "default" },
        defender: { cli: "codex", model: "g", effort: "default" },
        blockingSeverity: "major",
        timeoutSecs: 600,
        scopePaths: ["app/Services/Payment", "resources/js/Pages/Entries"],
        diffMode: "committed",
      },
      passes: [],
      findings: ledger([]),
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      lastHeartbeat: 0,
      diffTruncated: false,
    };
    const md = renderReport(state);
    expect(md).toMatch(/\*\*Scope:\*\*.*app\/Services\/Payment.*resources\/js\/Pages\/Entries/);
  });

  it("labels the header as working tree when diffMode is working", () => {
    const state: DebateState = {
      status: "completed",
      settings: {
        projectPath: "/x",
        runId: "r",
        baseRef: "HEAD",
        mergeBase: "aaa",
        headSha: "bbb",
        rounds: 1,
        critic: { cli: "claude", model: "c", effort: "default" },
        defender: { cli: "codex", model: "g", effort: "default" },
        blockingSeverity: "major",
        timeoutSecs: 600,
        scopePaths: [],
        diffMode: "working",
      },
      passes: [],
      findings: ledger([]),
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      lastHeartbeat: 0,
      diffTruncated: false,
    };
    const md = renderReport(state);
    expect(md).toMatch(/working tree/i);
    expect(md).not.toMatch(/Merge base/);
  });

  it("flags a truncated diff at the total cap", () => {
    const state: DebateState = {
      status: "completed",
      settings: {
        projectPath: "/x",
        runId: "r",
        baseRef: "main",
        mergeBase: "a",
        headSha: "b",
        rounds: 1,
        critic: { cli: "claude", model: "c", effort: "default" },
        defender: { cli: "codex", model: "g", effort: "default" },
        blockingSeverity: "major",
        timeoutSecs: 600,
        scopePaths: [],
        diffMode: "committed",
      },
      passes: [],
      findings: ledger([]),
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      lastHeartbeat: 0,
      diffTruncated: true,
    };
    expect(renderReport(state)).toMatch(/Diff was cut before review/);
    expect(renderReport(state)).toMatch(/total size cap/);
  });

  it("flags per-file trimming and lists the trimmed files", () => {
    const state: DebateState = {
      status: "completed",
      settings: {
        projectPath: "/x",
        runId: "r",
        baseRef: "main",
        mergeBase: "a",
        headSha: "b",
        rounds: 1,
        critic: { cli: "claude", model: "c", effort: "default" },
        defender: { cli: "codex", model: "g", effort: "default" },
        blockingSeverity: "major",
        timeoutSecs: 600,
        scopePaths: [],
        diffMode: "committed",
      },
      passes: [],
      findings: ledger([]),
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      lastHeartbeat: 0,
      diffTruncated: true,
      diffFilesTruncated: ["src/huge.ts", "src/other-huge.ts"],
    };
    const md = renderReport(state);
    expect(md).toMatch(/2 files trimmed at the per-file cap/);
    expect(md).toMatch(/`src\/huge\.ts`/);
    expect(md).toMatch(/`src\/other-huge\.ts`/);
  });

  it("lists auto-excluded generated files without treating it as a warning", () => {
    const state: DebateState = {
      status: "completed",
      settings: {
        projectPath: "/x",
        runId: "r",
        baseRef: "main",
        mergeBase: "a",
        headSha: "b",
        rounds: 1,
        critic: { cli: "claude", model: "c", effort: "default" },
        defender: { cli: "codex", model: "g", effort: "default" },
        blockingSeverity: "major",
        timeoutSecs: 600,
        scopePaths: [],
        diffMode: "committed",
      },
      passes: [],
      findings: ledger([]),
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      lastHeartbeat: 0,
      diffTruncated: false,
      diffFilesExcluded: ["yarn.lock", "dist/main.js"],
    };
    const md = renderReport(state);
    expect(md).toMatch(/Auto-excluded 2 generated files/);
    expect(md).toMatch(/`yarn\.lock`/);
    expect(md).not.toMatch(/Diff was cut before review/);
  });
});

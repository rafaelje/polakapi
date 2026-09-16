import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));

import {
  contextModeDefaults,
  isCliEnabled,
  normalizeContextMode,
  type ContextModePreferences,
} from "./context-mode-preferences";

describe("normalizeContextMode", () => {
  it("falls back to the defaults for junk input", () => {
    expect(normalizeContextMode(null)).toEqual(contextModeDefaults);
    expect(normalizeContextMode("nonsense")).toEqual(contextModeDefaults);
    expect(normalizeContextMode({})).toEqual(contextModeDefaults);
  });

  it("keeps valid values", () => {
    const stored: ContextModePreferences = {
      enabled: true,
      clis: { claude: false, codex: true, opencode: true, cursor: false },
      storage: "project",
      promoteAfterSources: 5,
      bypassKb: 2,
      externalizeKb: 250,
      writeGitignore: true,
    };
    expect(normalizeContextMode(stored)).toEqual(stored);
  });

  it("defaults only the CLI flags that are missing", () => {
    const result = normalizeContextMode({ clis: { claude: false } });
    expect(result.clis.claude).toBe(false);
    expect(result.clis.codex).toBe(contextModeDefaults.clis.codex);
    expect(result.clis.opencode).toBe(contextModeDefaults.clis.opencode);
  });

  it("rejects an unknown storage mode", () => {
    expect(normalizeContextMode({ storage: "sideways" }).storage).toBe(contextModeDefaults.storage);
  });

  it("clamps numbers into range and rounds them", () => {
    expect(normalizeContextMode({ bypassKb: -5 }).bypassKb).toBe(0);
    expect(normalizeContextMode({ bypassKb: 99_999 }).bypassKb).toBe(1024);
    expect(normalizeContextMode({ promoteAfterSources: 7.6 }).promoteAfterSources).toBe(8);
    expect(normalizeContextMode({ promoteAfterSources: 0 }).promoteAfterSources).toBe(1);
  });

  it("ignores non-numeric thresholds instead of storing NaN", () => {
    expect(normalizeContextMode({ bypassKb: "big" }).bypassKb).toBe(contextModeDefaults.bypassKb);
    expect(normalizeContextMode({ externalizeKb: Number.NaN }).externalizeKb).toBe(
      contextModeDefaults.externalizeKb,
    );
  });

  it("keeps the externalize threshold above the bypass threshold", () => {
    // Otherwise there is no band left in which anything gets summarised.
    const result = normalizeContextMode({ bypassKb: 40, externalizeKb: 10 });
    expect(result.externalizeKb).toBeGreaterThan(result.bypassKb);
  });
});

describe("isCliEnabled", () => {
  const prefs = (patch: Partial<ContextModePreferences>): ContextModePreferences => ({
    ...contextModeDefaults,
    ...patch,
  });

  it("requires both the master switch and the per-CLI switch", () => {
    expect(isCliEnabled(prefs({ enabled: true }), "claude")).toBe(true);
    expect(isCliEnabled(prefs({ enabled: false }), "claude")).toBe(false);
    expect(isCliEnabled(prefs({ enabled: true }), "opencode")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import type { LayoutTemplate } from "./types";
import { createEmptyState } from "./workspaces-reducer";
import { deleteLayoutTemplate, saveLayoutTemplate } from "./workspaces-reducer-templates";

function makeTemplate(overrides?: Partial<LayoutTemplate>): LayoutTemplate {
  return {
    id: "t1",
    name: "Two Claude",
    specs: [
      { id: "a", cliId: "claude" },
      { id: "b", cliId: "claude" },
    ],
    layout: {
      type: "split",
      axis: "column",
      ratio: 0.5,
      first: { type: "pane", paneId: "a" },
      second: { type: "pane", paneId: "b" },
    },
    ...overrides,
  };
}

describe("saveLayoutTemplate", () => {
  it("appends a new template", () => {
    const s = saveLayoutTemplate(createEmptyState(), makeTemplate());
    expect(s.layoutTemplates).toHaveLength(1);
    expect(s.layoutTemplates?.[0]?.name).toBe("Two Claude");
  });

  it("trims the name and rejects empty names (identity)", () => {
    const base = createEmptyState();
    expect(saveLayoutTemplate(base, makeTemplate({ name: "   " }))).toBe(base);
    const s = saveLayoutTemplate(base, makeTemplate({ name: "  padded  " }));
    expect(s.layoutTemplates?.[0]?.name).toBe("padded");
  });

  it("upserts by case-insensitive name, keeping the original id", () => {
    let s = saveLayoutTemplate(createEmptyState(), makeTemplate());
    s = saveLayoutTemplate(
      s,
      makeTemplate({ id: "t2", name: "two claude", specs: [{ id: "x", cliId: "shell" }] }),
    );
    expect(s.layoutTemplates).toHaveLength(1);
    expect(s.layoutTemplates?.[0]?.id).toBe("t1");
    expect(s.layoutTemplates?.[0]?.specs).toEqual([{ id: "x", cliId: "shell" }]);
  });

  it("does not mutate the previous state", () => {
    const base = saveLayoutTemplate(createEmptyState(), makeTemplate());
    saveLayoutTemplate(base, makeTemplate({ id: "t2", name: "Other" }));
    expect(base.layoutTemplates).toHaveLength(1);
  });
});

describe("deleteLayoutTemplate", () => {
  it("removes the template by id", () => {
    const base = saveLayoutTemplate(createEmptyState(), makeTemplate());
    const s = deleteLayoutTemplate(base, "t1");
    expect(s.layoutTemplates).toHaveLength(0);
  });

  it("returns the same state reference for unknown ids", () => {
    const base = saveLayoutTemplate(createEmptyState(), makeTemplate());
    expect(deleteLayoutTemplate(base, "ghost")).toBe(base);
    const empty = createEmptyState();
    expect(deleteLayoutTemplate(empty, "ghost")).toBe(empty);
  });
});

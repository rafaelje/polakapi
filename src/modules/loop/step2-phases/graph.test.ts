import { describe, expect, it } from "vitest";

import { detectCycle, phaseSlug, slugToId, topologicalBatches } from "./graph";
import type { Phase } from "../step2-phases";

function p(id: string, name: string, deps: string[] = [], hasVisual = false): Phase {
  return { id, name, summary: "", dependsOn: deps, hasVisual };
}

describe("phaseSlug", () => {
  it("joins id and name with a dash", () => {
    expect(phaseSlug(p("01", "init"))).toBe("01-init");
    expect(phaseSlug(p("12", "render-grid"))).toBe("12-render-grid");
  });

  it("sanitizes unsafe characters in the name to dashes", () => {
    expect(phaseSlug(p("03", "load data!"))).toBe("03-load-data-");
    expect(phaseSlug(p("04", "with spaces"))).toBe("04-with-spaces");
  });
});

describe("slugToId", () => {
  it("extracts the leading numeric id", () => {
    expect(slugToId("01-init")).toBe("01");
    expect(slugToId("123-some-name")).toBe("123");
  });

  it("returns the slug verbatim when there's no leading number", () => {
    expect(slugToId("init")).toBe("init");
  });
});

describe("detectCycle", () => {
  it("returns null for an empty graph", () => {
    expect(detectCycle([])).toBeNull();
  });

  it("returns null for a DAG", () => {
    const phases = [p("01", "a"), p("02", "b", ["01"]), p("03", "c", ["01", "02"])];
    expect(detectCycle(phases)).toBeNull();
  });

  it("detects a direct cycle (A → A)", () => {
    const cycle = detectCycle([p("01", "a", ["01"])]);
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe("01");
    expect(cycle![cycle!.length - 1]).toBe("01");
  });

  it("detects a 2-node cycle (A → B → A)", () => {
    const phases = [p("01", "a", ["02"]), p("02", "b", ["01"])];
    const cycle = detectCycle(phases);
    expect(cycle).not.toBeNull();
    expect(new Set(cycle)).toEqual(new Set(["01", "02"]));
  });

  it("detects a multi-hop cycle", () => {
    const phases = [p("01", "a", ["03"]), p("02", "b", ["01"]), p("03", "c", ["02"])];
    expect(detectCycle(phases)).not.toBeNull();
  });

  it("ignores dead references (deps to non-existent ids)", () => {
    const phases = [p("01", "a", ["99"]), p("02", "b", ["01"])];
    expect(detectCycle(phases)).toBeNull();
  });
});

describe("topologicalBatches", () => {
  it("returns null when the graph has a cycle", () => {
    const phases = [p("01", "a", ["02"]), p("02", "b", ["01"])];
    expect(topologicalBatches(phases)).toBeNull();
  });

  it("groups independent phases into the same batch", () => {
    const phases = [p("01", "a"), p("02", "b"), p("03", "c")];
    const batches = topologicalBatches(phases);
    expect(batches).not.toBeNull();
    expect(batches!.length).toBe(1);
    expect(batches![0].map((b) => b.id).sort()).toEqual(["01", "02", "03"]);
  });

  it("produces sequential batches when dependencies form a chain", () => {
    const phases = [p("01", "a"), p("02", "b", ["01"]), p("03", "c", ["02"])];
    const batches = topologicalBatches(phases);
    expect(batches).not.toBeNull();
    expect(batches!.map((b) => b.map((p) => p.id))).toEqual([["01"], ["02"], ["03"]]);
  });

  it("packs phases with the same readiness into a batch (diamond)", () => {
    // 01 → {02, 03} → 04
    const phases = [
      p("01", "root"),
      p("02", "left", ["01"]),
      p("03", "right", ["01"]),
      p("04", "leaf", ["02", "03"]),
    ];
    const batches = topologicalBatches(phases);
    expect(batches).not.toBeNull();
    expect(batches!.length).toBe(3);
    expect(batches![0].map((p) => p.id)).toEqual(["01"]);
    expect(batches![1].map((p) => p.id).sort()).toEqual(["02", "03"]);
    expect(batches![2].map((p) => p.id)).toEqual(["04"]);
  });

  it("treats dead references as no-op edges", () => {
    const phases = [p("01", "a", ["99"]), p("02", "b", ["01"])];
    const batches = topologicalBatches(phases);
    expect(batches).not.toBeNull();
    expect(batches!.map((b) => b.map((p) => p.id))).toEqual([["01"], ["02"]]);
  });
});

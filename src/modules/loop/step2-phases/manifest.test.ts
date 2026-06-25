import { describe, expect, it } from "vitest";

import {
  normalizePhase,
  normalizePhaseDraft,
  parseAgentPhasesJson,
  parsePhasesManifest,
  serializePhasesManifest,
  stripCodeFence,
} from "./manifest";
import type { Phase } from "../step2-phases";

const sample: Phase[] = [
  { id: "01", name: "init", summary: "boot", dependsOn: [], hasVisual: false },
  { id: "02", name: "render", summary: "ui", dependsOn: ["01"], hasVisual: true },
];

describe("serializePhasesManifest / parsePhasesManifest", () => {
  it("round-trips a non-empty list", () => {
    const round = parsePhasesManifest(serializePhasesManifest(sample));
    expect(round).toEqual(sample);
  });

  it("emits a markdown wrapper with a ```json fence", () => {
    const md = serializePhasesManifest(sample);
    expect(md).toMatch(/^# Run phases/);
    expect(md).toContain("```json\n");
    expect(md).toContain('"phases":');
  });

  it("parses an empty document as an empty list", () => {
    expect(parsePhasesManifest("")).toEqual([]);
    expect(parsePhasesManifest("   \n\n  ")).toEqual([]);
  });

  it("parses raw JSON without a fence", () => {
    const raw = JSON.stringify({ phases: sample });
    expect(parsePhasesManifest(raw)).toEqual(sample);
  });

  it("parses a bare phase array (no `phases` wrapper)", () => {
    const raw = JSON.stringify(sample);
    expect(parsePhasesManifest(raw)).toEqual(sample);
  });

  it("returns an empty list on malformed JSON", () => {
    expect(parsePhasesManifest("# not json")).toEqual([]);
    expect(parsePhasesManifest("```json\n{ not json }\n```")).toEqual([]);
  });

  it("drops invalid entries silently (missing id or name)", () => {
    const raw = JSON.stringify({
      phases: [
        { id: "01", name: "ok" },
        { id: "02" }, // missing name → dropped
        { name: "no-id" }, // missing id → dropped
        { id: "03", name: "ok2", dependsOn: ["01"] },
      ],
    });
    const parsed = parsePhasesManifest(raw);
    expect(parsed.map((p) => p.id)).toEqual(["01", "03"]);
  });
});

describe("parseAgentPhasesJson", () => {
  it("parses a JSON wrapped in a ```json fence", () => {
    const text = "```json\n" + JSON.stringify({ phases: sample }) + "\n```";
    const drafts = parseAgentPhasesJson(text);
    expect(drafts.length).toBe(2);
    expect(drafts[0].id).toBe("01");
  });

  it("extracts the agent's logic / visual fields when present", () => {
    const text = JSON.stringify({
      phases: [
        {
          id: "01",
          name: "init",
          dependsOn: [],
          hasVisual: true,
          logic: "the logic body",
          visual: "<html/>",
        },
      ],
    });
    const drafts = parseAgentPhasesJson(text);
    expect(drafts[0].logic).toBe("the logic body");
    expect(drafts[0].visual).toBe("<html/>");
    expect(drafts[0].hasVisual).toBe(true);
  });

  it("returns [] on unparseable input", () => {
    expect(parseAgentPhasesJson("nope")).toEqual([]);
  });
});

describe("normalizePhase / normalizePhaseDraft", () => {
  it("normalizePhase strips logic/visual from a draft", () => {
    const draft = {
      id: "01",
      name: "x",
      dependsOn: ["02"],
      hasVisual: true,
      logic: "body",
      visual: "<i/>",
    };
    const phase = normalizePhase(draft);
    expect(phase).toEqual({
      id: "01",
      name: "x",
      summary: "",
      dependsOn: ["02"],
      hasVisual: true,
    });
  });

  it("normalizePhaseDraft filters non-string deps and defaults flags", () => {
    const draft = normalizePhaseDraft({
      id: "01",
      name: "x",
      dependsOn: ["02", 42, null, "03"],
    });
    expect(draft?.dependsOn).toEqual(["02", "03"]);
    expect(draft?.hasVisual).toBe(false);
    expect(draft?.summary).toBe("");
  });

  it("returns null when the entry is not an object", () => {
    expect(normalizePhase(null)).toBeNull();
    expect(normalizePhase("string")).toBeNull();
    expect(normalizePhase(42)).toBeNull();
  });
});

describe("stripCodeFence", () => {
  it("strips a wrapping fence with a language tag", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence("```js\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("strips a wrapping fence with no language tag", () => {
    expect(stripCodeFence("```\nhello\n```")).toBe("hello");
  });

  it("leaves the string untouched when there's no fence", () => {
    expect(stripCodeFence("hello")).toBe("hello");
  });

  it("does not strip a partial fence", () => {
    expect(stripCodeFence("```json\nhello")).toBe("```json\nhello");
  });
});

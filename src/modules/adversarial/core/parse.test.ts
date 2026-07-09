import { describe, expect, it } from "vitest";

import { isCompleteNewFinding, parsePassOutput } from "./parse";

describe("parsePassOutput", () => {
  it("extracts the LAST fenced json block", () => {
    const raw = [
      "Here is an example of what I'll emit:",
      "```json",
      '{"pass": "critic", "findings": [{"id":"EXAMPLE","action":"new"}]}',
      "```",
      "And my actual answer:",
      "```json",
      '{"pass":"critic","findings":[{"id":"F1","action":"new","file":"a.ts","line":10,"severity":"major","claim":"c","argument":"e"}]}',
      "```",
    ].join("\n");
    const res = parsePassOutput(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parsed.findings[0].id).toBe("F1");
    expect(res.parsed.findings[0].claim).toBe("c");
  });

  it("falls back to a raw JSON object when the fence is missing", () => {
    const raw =
      'here goes {"pass":"defender","findings":[{"id":"F1","action":"concede","argument":"ok"}]}';
    const res = parsePassOutput(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parsed.pass).toBe("defender");
  });

  it("returns an error on malformed JSON", () => {
    const raw = "```json\n{not json}\n```";
    const res = parsePassOutput(raw);
    expect(res.ok).toBe(false);
  });

  it("returns an error when no JSON is present", () => {
    const res = parsePassOutput("plain prose without any JSON");
    expect(res.ok).toBe(false);
  });

  it("infers action=new when a critic finding has file/severity/claim but no action", () => {
    const raw = [
      "```json",
      JSON.stringify({
        pass: "critic",
        findings: [
          {
            id: "F1",
            file: "src/foo.ts",
            line: 10,
            severity: "major",
            claim: "off by one",
            argument: "evidence",
          },
        ],
      }),
      "```",
    ].join("\n");
    const res = parsePassOutput(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parsed.findings).toHaveLength(1);
    expect(res.parsed.findings[0].action).toBe("new");
  });

  it("does not infer action=new when severity or claim is missing", () => {
    const raw =
      '```json\n{"pass":"critic","findings":[{"id":"F1","file":"a.ts","argument":"e"}]}\n```';
    const res = parsePassOutput(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parsed.findings).toHaveLength(0);
  });

  it("does not infer action=new for defender passes", () => {
    // Defenders never emit `new` — a missing action means a genuinely bad output.
    const raw =
      '```json\n{"pass":"defender","findings":[{"id":"F1","file":"a.ts","severity":"major","claim":"c","argument":"e"}]}\n```';
    const res = parsePassOutput(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parsed.findings).toHaveLength(0);
  });

  it("drops findings with unknown actions", () => {
    const raw =
      '```json\n{"pass":"critic","findings":[{"id":"F1","action":"bogus","argument":"e"}]}\n```';
    const res = parsePassOutput(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parsed.findings).toHaveLength(0);
  });

  it("drops findings without an id", () => {
    const raw = '```json\n{"pass":"critic","findings":[{"action":"withdraw","argument":"e"}]}\n```';
    const res = parsePassOutput(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parsed.findings).toHaveLength(0);
  });

  it("caps overly long arguments", () => {
    const long = "a".repeat(10_000);
    const raw = `\`\`\`json\n{"pass":"critic","findings":[{"id":"F1","action":"withdraw","argument":"${long}"}]}\n\`\`\``;
    const res = parsePassOutput(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.parsed.findings[0].argument.length).toBeLessThanOrEqual(4000);
  });
});

describe("isCompleteNewFinding", () => {
  it("requires file/severity/claim", () => {
    expect(
      isCompleteNewFinding({
        id: "F1",
        action: "new",
        argument: "e",
        file: "a.ts",
        severity: "major",
        claim: "c",
      }),
    ).toBe(true);
    expect(
      isCompleteNewFinding({
        id: "F1",
        action: "new",
        argument: "e",
        file: "",
        severity: "major",
        claim: "c",
      }),
    ).toBe(false);
    expect(
      isCompleteNewFinding({
        id: "F1",
        action: "new",
        argument: "e",
        file: "a.ts",
        severity: "major",
        claim: "",
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { filterAgents } from "./filter";
import type { AgentDef } from "./types";

function mk(
  name: string,
  description: string,
  files: { title: string; content: string }[],
): AgentDef {
  return {
    id: name,
    name,
    description,
    files: files.map((f, i) => ({ id: `${name}-${i}`, title: f.title, content: f.content })),
    createdAt: 0,
    updatedAt: 0,
  };
}

const agents: AgentDef[] = [
  mk("frontend reviewer", "React/CSS review checklist", [
    { title: "review-checklist.md", content: "check component boundaries and hook deps" },
    { title: "css-conventions.md", content: "tailwind first, no bootstrap" },
  ]),
  mk("pest test reviewer", "PHP Pest test quality", [
    { title: "pest.md", content: "look for arch tests and DatabaseTransactions" },
  ]),
  mk("api explorer", "spelunk REST endpoints", [{ title: "api.md", content: "curl and jq" }]),
];

describe("filterAgents", () => {
  it("returns all agents when query is empty or whitespace", () => {
    expect(filterAgents(agents, "")).toHaveLength(3);
    expect(filterAgents(agents, "   ")).toHaveLength(3);
  });

  it("matches by name (case-insensitive)", () => {
    const out = filterAgents(agents, "PEST");
    expect(out.map((a) => a.name)).toEqual(["pest test reviewer"]);
  });

  it("matches by description", () => {
    const out = filterAgents(agents, "checklist");
    expect(out.map((a) => a.name)).toEqual(["frontend reviewer"]);
  });

  it("matches by file title", () => {
    const out = filterAgents(agents, "css-conventions");
    expect(out.map((a) => a.name)).toEqual(["frontend reviewer"]);
  });

  it("matches by file content", () => {
    const out = filterAgents(agents, "tailwind");
    expect(out.map((a) => a.name)).toEqual(["frontend reviewer"]);
  });

  it("requires all tokens to match (AND across fields)", () => {
    const out = filterAgents(agents, "reviewer pest");
    expect(out.map((a) => a.name)).toEqual(["pest test reviewer"]);
  });

  it("returns empty when a token is absent", () => {
    expect(filterAgents(agents, "reviewer bootstrap tailwind")).toHaveLength(1);
    expect(filterAgents(agents, "reviewer nomatchtoken")).toEqual([]);
  });

  it("returns a fresh array (does not mutate input)", () => {
    const out = filterAgents(agents, "");
    expect(out).not.toBe(agents);
  });
});

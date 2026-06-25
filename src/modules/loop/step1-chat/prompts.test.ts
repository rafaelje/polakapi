import { describe, expect, it } from "vitest";

import {
  buildConsolidateInstruction,
  buildConsolidatePrompt,
  buildHistoryPrompt,
  looksLikeSessionError,
  parseDraftMarkdown,
  serializeDraftMarkdown,
} from "./prompts";
import type { ChatTurn } from "./state";

function turn(user: string, assistant = "", extra: Partial<ChatTurn> = {}): ChatTurn {
  return { user, assistant, pending: false, ...extra };
}

describe("buildHistoryPrompt", () => {
  it("includes the current user message at the end with a reply instruction", () => {
    const out = buildHistoryPrompt([], "what's the goal?");
    expect(out).toContain("# Current user message");
    expect(out).toContain("what's the goal?");
    expect(out).toContain("continuing the conversation");
  });

  it("omits the prior-conversation block when history is empty", () => {
    const out = buildHistoryPrompt([], "hi");
    expect(out).not.toContain("Prior conversation");
  });

  it("emits ordered ## User / ## Agent blocks for prior turns", () => {
    const out = buildHistoryPrompt([turn("first", "ack1"), turn("second", "ack2")], "third");
    expect(out).toMatch(/## User\nfirst/);
    expect(out).toMatch(/## Agent\nack1/);
    expect(out).toMatch(/## User\nsecond/);
    expect(out).toMatch(/## Agent\nack2/);
    // The order is user1, agent1, user2, agent2, current.
    const idxUser1 = out.indexOf("first");
    const idxAgent1 = out.indexOf("ack1");
    const idxUser2 = out.indexOf("second");
    const idxAgent2 = out.indexOf("ack2");
    const idxCurrent = out.indexOf("third");
    expect(idxUser1 < idxAgent1).toBe(true);
    expect(idxAgent1 < idxUser2).toBe(true);
    expect(idxUser2 < idxAgent2).toBe(true);
    expect(idxAgent2 < idxCurrent).toBe(true);
  });

  it("skips the agent block when the assistant text is empty", () => {
    const out = buildHistoryPrompt([turn("hi", "")], "follow up");
    expect(out).toMatch(/## User\nhi/);
    expect(out).not.toContain("## Agent\n");
  });
});

describe("buildConsolidatePrompt / buildConsolidateInstruction", () => {
  it("emits the full-conversation block plus the task block", () => {
    const out = buildConsolidatePrompt([turn("hi", "hello"), turn("bye", "")]);
    expect(out).toContain("# Full conversation");
    expect(out).toContain("# Task");
    expect(out).toContain("hi");
    expect(out).toContain("hello");
    expect(out).toContain("bye");
  });

  it("the consolidate instruction asks for the canonical structure", () => {
    const instr = buildConsolidateInstruction();
    expect(instr).toContain("# Problem");
    expect(instr).toContain("## Context");
    expect(instr).toContain("## Goal");
    expect(instr).toContain("## Constraints");
    expect(instr).toContain("## Success criteria");
    expect(instr).toContain("## Known risks");
  });
});

describe("looksLikeSessionError", () => {
  it("matches common English failure modes", () => {
    expect(looksLikeSessionError("Session not found")).toBe(true);
    expect(looksLikeSessionError("the session expired 5m ago")).toBe(true);
    expect(looksLikeSessionError("invalid session token")).toBe(true);
  });

  it("matches CLI-upstream Spanish substrings (kept on purpose)", () => {
    expect(looksLikeSessionError("session no encontrada")).toBe(true);
    expect(looksLikeSessionError("session no existe")).toBe(true);
  });

  it("returns false for unrelated error strings", () => {
    expect(looksLikeSessionError("Network unreachable")).toBe(false);
    expect(looksLikeSessionError("rate limited")).toBe(false);
    // Mentions "session" but no failure verb.
    expect(looksLikeSessionError("session created successfully")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(looksLikeSessionError("SESSION NOT FOUND")).toBe(true);
  });
});

describe("serializeDraftMarkdown / parseDraftMarkdown", () => {
  it("round-trips a non-empty draft", () => {
    const turns = [turn("first user msg", "first ack"), turn("second user msg")];
    const md = serializeDraftMarkdown(turns);
    const back = parseDraftMarkdown(md);
    expect(back.length).toBe(2);
    expect(back[0].user).toBe("first user msg");
    expect(back[0].assistant).toBe("first ack");
    expect(back[1].user).toBe("second user msg");
    expect(back[1].assistant).toBe("");
  });

  it("emits an error line when the turn had one", () => {
    const md = serializeDraftMarkdown([turn("x", "y", { error: "boom" })]);
    expect(md).toContain("> error: boom");
  });

  it("returns an empty list on an empty draft", () => {
    expect(parseDraftMarkdown("")).toEqual([]);
    expect(parseDraftMarkdown("# Problem draft (auto-save)")).toEqual([]);
  });

  it("skips turn blocks with no user text", () => {
    const md = "# Problem draft (auto-save)\n## Turn 1\n### User\n\n### Agent\nalone\n";
    expect(parseDraftMarkdown(md)).toEqual([]);
  });
});

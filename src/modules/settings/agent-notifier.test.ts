import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn() }));
import { AgentNotificationPolicy, type AgentEvent } from "./agent-notifier";
import { defaults, normalizePreferences } from "./preferences";

const event = (ptyId: string, kind: AgentEvent["kind"]): AgentEvent => ({
  ptyId,
  kind,
  cli: "claude",
});

describe("agent notification policy", () => {
  it("waits for all tracked agents and emits each completion once", () => {
    const policy = new AgentNotificationPolicy();
    expect(
      policy.process(
        [event("a", "started"), event("b", "started"), event("a", "finished")],
        defaults,
      ),
    ).toEqual([]);
    expect(policy.process([event("a", "finished")], defaults)).toEqual([]);
    expect(policy.process([event("b", "finished")], defaults)).toEqual([
      event("a", "finished"),
      event("b", "finished"),
    ]);
    expect(policy.process([event("b", "finished")], defaults)).toEqual([]);
  });
  it("honors independent permission, waiting, and completion preferences", () => {
    const policy = new AgentNotificationPolicy();
    const disabled = { ...defaults, permission: false, waiting: false, finished: "never" as const };
    expect(
      policy.process(
        [event("a", "permission"), event("a", "waiting"), event("a", "finished")],
        disabled,
      ),
    ).toEqual([]);
  });
  it("notifies permissions during other work but suppresses waiting notices", () => {
    const policy = new AgentNotificationPolicy();
    expect(
      policy.process(
        [event("a", "started"), event("b", "permission"), event("c", "waiting")],
        defaults,
      ),
    ).toEqual([event("b", "permission")]);
  });
  it("releases pending completions when the remaining terminal exits", () => {
    const policy = new AgentNotificationPolicy();
    policy.process(
      [event("a", "started"), event("b", "started"), event("a", "finished")],
      defaults,
    );
    expect(policy.process([event("b", "ended")], defaults)).toEqual([event("a", "finished")]);
  });
  it("cancels an obsolete pending completion when a new turn starts", () => {
    const policy = new AgentNotificationPolicy();
    policy.process(
      [event("a", "started"), event("b", "started"), event("a", "finished")],
      defaults,
    );
    expect(policy.process([event("a", "started"), event("b", "ended")], defaults)).toEqual([]);
    expect(policy.process([event("a", "finished")], defaults)).toEqual([event("a", "finished")]);
  });
  it("can notify immediately while other agents remain active", () => {
    const policy = new AgentNotificationPolicy();
    expect(
      policy.process([event("a", "started"), event("b", "finished")], {
        ...defaults,
        finished: "immediately",
      }),
    ).toEqual([event("b", "finished")]);
  });
  it("waits for background subagents after the parent turn finishes", () => {
    const policy = new AgentNotificationPolicy();
    expect(
      policy.process(
        [event("a", "started"), event("a:subagent:child", "started"), event("a", "finished")],
        defaults,
      ),
    ).toEqual([]);
    expect(policy.process([event("a:subagent:child", "ended")], defaults)).toEqual([
      event("a", "finished"),
    ]);
  });
  it("does not emit an idle alert when work starts later in the same poll", () => {
    const policy = new AgentNotificationPolicy();
    expect(policy.process([event("a", "waiting"), event("b", "started")], defaults)).toEqual([]);
  });
  it("repairs malformed persisted preferences", () => {
    expect(normalizePreferences({ desktop: "no", finished: "unknown", sound: 12 })).toEqual(
      defaults,
    );
  });
});

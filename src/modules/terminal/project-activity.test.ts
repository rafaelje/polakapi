import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectId } from "../workspaces/state/types";
import { ProjectActivityTracker } from "./project-activity";

function pid(value: string): ProjectId {
  return value as ProjectId;
}

describe("ProjectActivityTracker", () => {
  const projectId = pid("p1");
  const sourceId = "pty-1";
  const liveCounts = new Map<ProjectId, number>();
  const changes: string[] = [];
  let tracker: ProjectActivityTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    liveCounts.clear();
    changes.length = 0;
    tracker = new ProjectActivityTracker({
      getLiveCount: (id) => liveCounts.get(id) ?? 0,
      onChange: (_id, state) => changes.push(state),
      workingMs: 3_000,
      recentMs: 10_000,
      confirmationWindowMs: 800,
      confirmationGapMs: 100,
    });
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it("moves a live project from ready to working and back after activity stops", () => {
    liveCounts.set(projectId, 1);
    tracker.refresh(projectId);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(100);
    tracker.record(projectId, sourceId);

    expect(changes).toEqual(["ready", "working"]);
    vi.advanceTimersByTime(2_999);
    expect(tracker.get(projectId)).toBe("working");
    vi.advanceTimersByTime(1);

    expect(tracker.get(projectId)).toBe("ready");
    expect(changes).toEqual(["ready", "working", "ready"]);
  });

  it("extends the working window without emitting duplicate changes", () => {
    liveCounts.set(projectId, 1);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(100);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(2_000);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(100);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(2_999);

    expect(tracker.get(projectId)).toBe("working");
    expect(changes).toEqual(["ready", "working"]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual(["ready", "working", "ready"]);
  });

  it("does not let an isolated redraw extend an active state", () => {
    liveCounts.set(projectId, 1);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(100);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(2_000);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(1_000);

    expect(tracker.get(projectId)).toBe("ready");
    expect(changes).toEqual(["ready", "working", "ready"]);
  });

  it("keeps a closed project recent before returning to idle", () => {
    liveCounts.set(projectId, 1);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(100);
    tracker.record(projectId, sourceId);
    liveCounts.set(projectId, 0);
    tracker.refresh(projectId);

    expect(tracker.get(projectId)).toBe("recent");
    vi.advanceTimersByTime(10_000);

    expect(tracker.get(projectId)).toBe("idle");
    expect(changes).toEqual(["ready", "working", "recent", "idle"]);
  });

  it("clears scheduled transitions when a project is deleted", () => {
    liveCounts.set(projectId, 1);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(100);
    tracker.record(projectId, sourceId);
    tracker.delete(projectId);
    vi.advanceTimersByTime(3_000);

    expect(changes).toEqual(["ready", "working"]);
  });

  it("ignores isolated periodic redraws", () => {
    liveCounts.set(projectId, 1);
    tracker.refresh(projectId);

    for (let i = 0; i < 4; i += 1) {
      tracker.record(projectId, sourceId);
      vi.advanceTimersByTime(5_000);
    }

    expect(tracker.get(projectId)).toBe("ready");
    expect(changes).toEqual(["ready"]);
  });

  it("treats rapid chunks from one redraw as a single pulse", () => {
    liveCounts.set(projectId, 1);
    tracker.refresh(projectId);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(30);
    tracker.record(projectId, sourceId);
    vi.advanceTimersByTime(30);
    tracker.record(projectId, sourceId);

    expect(tracker.get(projectId)).toBe("ready");
    expect(changes).toEqual(["ready"]);
  });

  it("does not combine isolated output from different terminals", () => {
    liveCounts.set(projectId, 2);
    tracker.refresh(projectId);
    tracker.record(projectId, "pty-1");
    vi.advanceTimersByTime(200);
    tracker.record(projectId, "pty-2");

    expect(tracker.get(projectId)).toBe("ready");
    expect(changes).toEqual(["ready"]);
  });
});

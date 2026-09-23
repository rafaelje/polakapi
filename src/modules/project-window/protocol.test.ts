import { describe, expect, it } from "vitest";
import { isProjectWindowClosed, isProjectWindowUpdate } from "./protocol";

describe("project window protocol", () => {
  it("accepts updates that carry only what changed", () => {
    expect(isProjectWindowUpdate({ projectId: "p1" })).toBe(true);
    expect(isProjectWindowUpdate({ projectId: "p1", liveCount: 2 })).toBe(true);
    expect(isProjectWindowUpdate({ projectId: "p1", layout: null })).toBe(true);
    expect(isProjectWindowUpdate({ projectId: "p1", specs: [] })).toBe(true);
    expect(isProjectWindowUpdate({ projectId: "p1", bell: { paneId: "a", pending: true } })).toBe(
      true,
    );
  });

  it("rejects malformed updates from another window", () => {
    expect(isProjectWindowUpdate(null)).toBe(false);
    expect(isProjectWindowUpdate({})).toBe(false);
    expect(isProjectWindowUpdate({ projectId: "p1", specs: "nope" })).toBe(false);
    expect(isProjectWindowUpdate({ projectId: "p1", liveCount: "2" })).toBe(false);
    expect(isProjectWindowUpdate({ projectId: "p1", bell: { paneId: 1 } })).toBe(false);
  });

  it("recognises the closed notification", () => {
    expect(isProjectWindowClosed({ projectId: "p1" })).toBe(true);
    expect(isProjectWindowClosed({})).toBe(false);
    expect(isProjectWindowClosed("p1")).toBe(false);
  });
});

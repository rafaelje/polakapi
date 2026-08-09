import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./map-with-concurrency";

describe("mapWithConcurrency", () => {
  it("limits active work and preserves input order", async () => {
    let active = 0;
    let maxActive = 0;

    const results = await mapWithConcurrency([30, 5, 20, 1], 2, async (delay, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return index;
    });

    expect(maxActive).toBe(2);
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("rejects invalid concurrency", async () => {
    await expect(mapWithConcurrency([1], 0, (value) => Promise.resolve(value))).rejects.toThrow(
      "Concurrency must be a positive integer",
    );
  });
});

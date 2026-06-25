import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HeartbeatController } from "./heartbeat";

describe("HeartbeatController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("starts a timer on first start() and stops on matching stop()", () => {
    const onPulse = vi.fn();
    const hb = new HeartbeatController(50, onPulse);

    hb.start();
    vi.advanceTimersByTime(150);
    expect(onPulse).toHaveBeenCalledTimes(3);

    hb.stop();
    vi.advanceTimersByTime(150);
    expect(onPulse).toHaveBeenCalledTimes(3);
  });

  it("keeps the timer alive while any ref is held (parallel phases)", () => {
    const onPulse = vi.fn();
    const hb = new HeartbeatController(50, onPulse);

    hb.start();
    hb.start();
    hb.start();
    vi.advanceTimersByTime(50);
    expect(onPulse).toHaveBeenCalledTimes(1);

    hb.stop();
    vi.advanceTimersByTime(50);
    expect(onPulse).toHaveBeenCalledTimes(2);

    hb.stop();
    vi.advanceTimersByTime(50);
    expect(onPulse).toHaveBeenCalledTimes(3);

    hb.stop();
    vi.advanceTimersByTime(150);
    expect(onPulse).toHaveBeenCalledTimes(3);
  });

  it("guards against refcount underflow when stop() is called too many times", () => {
    const onPulse = vi.fn();
    const hb = new HeartbeatController(50, onPulse);

    expect(() => hb.stop()).not.toThrow();
    expect(() => hb.stop()).not.toThrow();

    // If extra stops had pushed refs negative, the next start/stop pair
    // would never reach 0 and the timer would leak.
    hb.start();
    vi.advanceTimersByTime(50);
    expect(onPulse).toHaveBeenCalledTimes(1);
    hb.stop();
    vi.advanceTimersByTime(100);
    expect(onPulse).toHaveBeenCalledTimes(1);
  });

  it("reset() clears refs and timer regardless of how many starts were issued", () => {
    const onPulse = vi.fn();
    const hb = new HeartbeatController(50, onPulse);

    hb.start();
    hb.start();
    hb.start();
    vi.advanceTimersByTime(50);
    expect(onPulse).toHaveBeenCalledTimes(1);

    hb.reset();
    vi.advanceTimersByTime(200);
    expect(onPulse).toHaveBeenCalledTimes(1);

    hb.start();
    vi.advanceTimersByTime(50);
    expect(onPulse).toHaveBeenCalledTimes(2);
    hb.stop();
    vi.advanceTimersByTime(100);
    expect(onPulse).toHaveBeenCalledTimes(2);
  });

  it("does not re-create the interval when start() is called while running", () => {
    const onPulse = vi.fn();
    const hb = new HeartbeatController(50, onPulse);

    hb.start();
    hb.start();
    vi.advanceTimersByTime(120);
    expect(onPulse).toHaveBeenCalledTimes(2);

    hb.stop();
    hb.stop();
  });
});

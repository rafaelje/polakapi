import { describe, expect, it } from "vitest";

import { PersistenceQueue } from "./persistence";

describe("PersistenceQueue", () => {
  it("runs writes in enqueue order, never overlapping", async () => {
    const queue = new PersistenceQueue();
    const order: string[] = [];
    let inflight = 0;
    let peak = 0;

    const make = (label: string, delayMs: number) => async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(label);
      inflight -= 1;
    };

    const p1 = queue.enqueue(make("a", 30));
    const p2 = queue.enqueue(make("b", 5));
    const p3 = queue.enqueue(make("c", 10));

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual(["a", "b", "c"]);
    expect(peak).toBe(1);
  });

  it("swallows write errors so the scheduler keeps running", async () => {
    const queue = new PersistenceQueue();
    let after = false;

    const failing = queue.enqueue(() => Promise.reject(new Error("disk full")));
    const ok = queue.enqueue(async () => {
      after = true;
    });

    await expect(failing).resolves.toBeUndefined();
    await ok;
    expect(after).toBe(true);
  });

  it("does not block subsequent writes when a sync throw occurs in the writer", async () => {
    const queue = new PersistenceQueue();
    let landed = false;

    const bomb = queue.enqueue(() => {
      throw new Error("boom");
    });
    const next = queue.enqueue(async () => {
      landed = true;
    });

    await expect(bomb).resolves.toBeUndefined();
    await next;
    expect(landed).toBe(true);
  });

  it("serializes writes enqueued while a write is in flight", async () => {
    const queue = new PersistenceQueue();
    const order: string[] = [];

    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = queue.enqueue(async () => {
      await gate;
      order.push("first");
    });
    const second = queue.enqueue(async () => {
      order.push("second");
    });

    expect(order).toEqual([]);
    release!();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });
});

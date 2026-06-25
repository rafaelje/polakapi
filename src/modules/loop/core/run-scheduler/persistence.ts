// Serializes `state.json` writes: the Tauri backend's tmp+rename pattern
// can clobber its temp file under concurrent writes from parallel phases.

export class PersistenceQueue {
  private inFlight: Promise<void> = Promise.resolve();

  enqueue(write: () => Promise<void>): Promise<void> {
    const next = this.inFlight.then(write).catch((err: unknown) => {
      // Best-effort: a failed write is logged but never propagates so the
      // scheduler keeps running.
      console.error("loop scheduler: persistence write failed", err);
    });
    this.inFlight = next;
    return next;
  }
}

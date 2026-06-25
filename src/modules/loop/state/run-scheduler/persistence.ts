// Serial writer for `state.json`. Every `enqueue()` chains onto the
// previous write so two parallel phases never end up writing the file
// concurrently (the Tauri backend uses a tmp+rename pattern that can
// otherwise clobber its temp file). The returned promise resolves once
// THIS specific write hits disk — callers that need write-then-continue
// semantics can `await` their own enqueue.

export class PersistenceQueue {
  private inFlight: Promise<void> = Promise.resolve();

  enqueue(write: () => Promise<void>): Promise<void> {
    const next = this.inFlight.then(write).catch((err: unknown) => {
      // Persistence is best-effort: a failed write is logged but never
      // propagates — the scheduler must keep running. Each individual
      // write is responsible for surfacing its own error if it cares.
      console.error("loop scheduler: persistence write failed", err);
    });
    this.inFlight = next;
    return next;
  }
}

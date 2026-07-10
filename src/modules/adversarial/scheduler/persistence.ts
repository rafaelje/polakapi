// Serial queue for state.json writes — mirrors the loop-scheduler pattern so
// concurrent commits don't race on the atomic rename.

export class PersistenceQueue {
  private inFlight: Promise<void> = Promise.resolve();

  enqueue(write: () => Promise<void>): Promise<void> {
    const next = this.inFlight.then(write, write);
    // Swallow errors so a failed write doesn't wedge the queue.
    this.inFlight = next.catch((err) => {
      console.error("adversarial: state.json write failed", err);
    });
    return next;
  }

  async drain(): Promise<void> {
    await this.inFlight;
  }
}

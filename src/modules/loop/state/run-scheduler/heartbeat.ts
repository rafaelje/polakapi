// Reference-counted heartbeat timer.
//
// The interrupted-runs detector treats a `state.json` whose `lastHeartbeat`
// is older than ~N×3 seconds as a crashed run. In hybrid mode several
// phases can have an in-flight CLI invocation at the same time — without
// the refcount, the first phase to finish would clear the heartbeat that
// the other phases still depend on and the detector would flag the run as
// crashed even though it is still alive.
//
// Decoupled from the scheduler class so it can be unit-tested and so the
// phase runner can hold a reference without pulling in the whole class.

export class HeartbeatController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private refs = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly onPulse: () => void,
  ) {}

  start(): void {
    this.refs += 1;
    if (this.timer === null) {
      this.timer = setInterval(() => this.onPulse(), this.intervalMs);
    }
  }

  stop(): void {
    if (this.refs > 0) this.refs -= 1;
    if (this.refs === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Hard reset — drops every ref and clears the timer unconditionally. */
  reset(): void {
    this.refs = 0;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// Reference-counted: hybrid mode runs phases in parallel, and without the
// refcount the first phase to finish would clear the heartbeat the others
// still depend on, making the interrupted-runs detector flag a live run
// as crashed.

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

  reset(): void {
    this.refs = 0;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

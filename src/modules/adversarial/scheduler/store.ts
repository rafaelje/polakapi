// Minimal observable store — the debate scheduler owns the state, the UI
// subscribes for snapshots.

import type { DebateState } from "../types";

export type Listener = (state: DebateState) => void;

export class DebateStore {
  private state: DebateState;
  private readonly listeners = new Set<Listener>();

  constructor(initial: DebateState) {
    this.state = initial;
  }

  get(): DebateState {
    return this.state;
  }

  commit(next: DebateState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
}

import type { KeyPress } from "../code-review-model";

export interface CommitState {
  stagedCount: number;
  message: string;
  busy: boolean;
}

export function canCommit(state: CommitState): boolean {
  return !state.busy && state.stagedCount > 0 && state.message.trim() !== "";
}

export function isCommitShortcut(press: KeyPress): boolean {
  return press.key === "Enter" && Boolean(press.ctrlKey || press.metaKey) && !press.altKey;
}

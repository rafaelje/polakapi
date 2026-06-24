import type { ProjectId } from "../workspaces/state/types";

export interface NotesElements {
  panel: HTMLElement | null;
  textarea: HTMLTextAreaElement | null;
}

/**
 * Port consumed by the notes panel. Implemented in workspaces-bootstrap as an
 * adapter over WorkspacesController + WorkspacesEvent. Keeping the contract
 * narrow lets the panel stay agnostic of the workspaces state shape and
 * lets unit tests drive it with a hand-rolled fake.
 */
export interface NotesSource {
  getActiveProjectId(): ProjectId | null;
  getNotes(projectId: ProjectId): string;
  /** Called from the panel after its local 400ms debounce. */
  setNotes(projectId: ProjectId, value: string): void;
  /** Subscribe to active-project changes. Returns an unsubscribe fn. */
  on(event: "active-project-changed", cb: (projectId: ProjectId | null) => void): () => void;
}

export interface NotesPanelHandle {
  /**
   * Removes listeners and cancels the debounce timer. If a pending value is
   * buffered, it is flushed synchronously to the source before returning so
   * the parent dispose() chain (which then flushes workspaces-store) does not
   * lose the last keystrokes.
   */
  dispose(): void;
}

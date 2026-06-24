import type { ProjectId } from "../workspaces/state/types";
import type { NotesElements, NotesPanelHandle, NotesSource } from "./types";

// ---------------------------------------------------------------------------
// F3 notes panel.
//
// Responsibilities:
//   - Mirror the active project's notes into the textarea.
//   - Debounce user input (400ms by default) before pushing it to the source.
//   - On project swap, flush the previous project's pending value SYNCHRONOUSLY
//     under its OWN id (captured at write time) before loading the new value.
//   - Empty state: when no project is active, disable the textarea and toggle
//     `.notes-empty` on the panel so CSS can style the placeholder.
//
// Design note: this panel listens ONLY to 'active-project-changed', never to
// 'state-changed'. Reacting to state-changed would overwrite the textarea
// while the user is mid-keystroke (the controller emits state-changed for
// every setProjectNotes call we just made).
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 400;
const EMPTY_PLACEHOLDER = "Select a project to take notes";

export function getNotesElements(): NotesElements {
  return {
    panel: document.getElementById("notes"),
    textarea: document.querySelector<HTMLTextAreaElement>(".notes-body"),
  };
}

/** Height-only — notes content is no longer a global layout field. */
export function applyNotesHeight(layout: { notesHeight?: number }, elements: NotesElements): void {
  if (typeof layout.notesHeight === "number" && elements.panel) {
    elements.panel.style.flex = `0 0 ${layout.notesHeight}px`;
  }
}

export interface MountNotesPanelOptions {
  elements: NotesElements;
  source: NotesSource;
  /** Override for tests; default 400ms. */
  debounceMs?: number;
}

export function mountNotesPanel(opts: MountNotesPanelOptions): NotesPanelHandle {
  const { elements, source } = opts;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const { textarea, panel } = elements;

  // No DOM to drive: return a noop handle. Bootstrap may run before the panel
  // markup exists in tests, so we degrade gracefully.
  if (!textarea) {
    return { dispose: () => {} };
  }

  let currentProjectId: ProjectId | null = null;
  let pendingValue: string | null = null;
  let pendingForProject: ProjectId | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const defaultPlaceholder = textarea.placeholder;

  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // Synchronously flush whatever is buffered to whichever project we captured
  // it for. Called on project swap and on dispose.
  const flushPending = (): void => {
    if (pendingValue === null || pendingForProject === null) {
      pendingValue = null;
      pendingForProject = null;
      return;
    }
    const value = pendingValue;
    const pid = pendingForProject;
    pendingValue = null;
    pendingForProject = null;
    source.setNotes(pid, value);
  };

  const enterEmptyState = (): void => {
    textarea.value = "";
    textarea.disabled = true;
    textarea.placeholder = EMPTY_PLACEHOLDER;
    panel?.classList.add("notes-empty");
  };

  const exitEmptyState = (): void => {
    textarea.disabled = false;
    textarea.placeholder = defaultPlaceholder;
    panel?.classList.remove("notes-empty");
  };

  const loadProject = (pid: ProjectId | null): void => {
    currentProjectId = pid;
    if (pid === null) {
      enterEmptyState();
      return;
    }
    exitEmptyState();
    textarea.value = source.getNotes(pid);
  };

  const onInput = (): void => {
    if (disposed) return;
    const pid = currentProjectId;
    if (pid === null) return;
    pendingValue = textarea.value;
    pendingForProject = pid;
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      flushPending();
    }, debounceMs);
  };

  textarea.addEventListener("input", onInput);

  // Subscribe to active-project changes. On swap: cancel timer, flush any
  // buffered value under the PREVIOUS project's id (captured at write time
  // via `pendingForProject`), then load the new project's notes.
  const unsubscribe = source.on("active-project-changed", (nextPid) => {
    if (disposed) return;
    cancelTimer();
    flushPending();
    loadProject(nextPid);
  });

  // Initial load.
  loadProject(source.getActiveProjectId());

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      textarea.removeEventListener("input", onInput);
      unsubscribe();
      cancelTimer();
      flushPending();
    },
  };
}

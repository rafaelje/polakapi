import { type PersistedLayout, queueSave } from "../../shared/persistence";

export interface NotesElements {
  panel: HTMLElement | null;
  textarea: HTMLTextAreaElement | null;
}

export function getNotesElements(): NotesElements {
  return {
    panel: document.getElementById("notes"),
    textarea: document.querySelector<HTMLTextAreaElement>(".notes-body"),
  };
}

export function persistNotesHeight(panel: HTMLElement | null): void {
  if (!panel) return;
  queueSave({ notesHeight: panel.getBoundingClientRect().height });
}

export function wireNotes(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.addEventListener("input", () => {
    queueSave({ notesContent: textarea.value });
  });
}

export function applyNotesLayout(layout: PersistedLayout, elements: NotesElements): void {
  if (typeof layout.notesHeight === "number" && elements.panel) {
    elements.panel.style.flex = `0 0 ${layout.notesHeight}px`;
  }
  if (typeof layout.notesContent === "string" && elements.textarea) {
    elements.textarea.value = layout.notesContent;
  }
}

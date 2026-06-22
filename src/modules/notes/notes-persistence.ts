import { queueSave } from "../../shared/persistence/store";

export function persistNotesHeight(panel: HTMLElement | null): void {
  if (!panel) return;
  queueSave({ notesHeight: panel.getBoundingClientRect().height });
}

export function wireNotesPersistence(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.addEventListener("input", () => {
    queueSave({ notesContent: textarea.value });
  });
}

import { queueSave } from "../../shared/persistence/store";

// Notes content moved to per-project storage in F3 — only the panel height
// remains a global UI preference in layout.json.
export function persistNotesHeight(panel: HTMLElement | null): void {
  if (!panel) return;
  queueSave({ notesHeight: panel.getBoundingClientRect().height });
}

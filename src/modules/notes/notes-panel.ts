import { type PersistedLayout } from "../../shared/persistence/store";
import { type NotesElements } from "./types";

export function getNotesElements(): NotesElements {
  return {
    panel: document.getElementById("notes"),
    textarea: document.querySelector<HTMLTextAreaElement>(".notes-body"),
  };
}

export function applyNotesLayout(layout: PersistedLayout, elements: NotesElements): void {
  if (typeof layout.notesHeight === "number" && elements.panel) {
    elements.panel.style.flex = `0 0 ${layout.notesHeight}px`;
  }
  if (typeof layout.notesContent === "string" && elements.textarea) {
    elements.textarea.value = layout.notesContent;
  }
}

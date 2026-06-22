import { getNotesElements } from "../modules/notes/notes-panel";
import { type NotesElements } from "../modules/notes/types";
import { requireById } from "../shared/dom/dom";

export interface AppElements {
  gridEl: HTMLDivElement;
  sidebarLeft: HTMLElement;
  sidebarRight: HTMLElement;
  layoutEl: HTMLElement;
  mainRow: HTMLElement;
  rightCol: HTMLElement;
  notesGutter: HTMLElement | null;
  notes: NotesElements;
  addPaneButton: HTMLElement | null;
  runAllButton: HTMLElement | null;
  gridColsInput: HTMLInputElement | null;
}

export function getAppElements(): AppElements {
  const gridColsEl = document.getElementById("grid-cols");

  return {
    gridEl: requireById<HTMLDivElement>("grid", HTMLDivElement),
    sidebarLeft: requireById("sidebar-left"),
    sidebarRight: requireById("sidebar-right"),
    layoutEl: requireById("layout"),
    mainRow: requireById("main-row"),
    rightCol: requireById("right-col"),
    notesGutter: document.getElementById("gutter-notes"),
    notes: getNotesElements(),
    addPaneButton: document.getElementById("add-pane"),
    runAllButton: document.getElementById("run-all"),
    gridColsInput: gridColsEl instanceof HTMLInputElement ? gridColsEl : null,
  };
}

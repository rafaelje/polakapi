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
  /** Toolbar slot for the workspace > project breadcrumb. */
  breadcrumbHost: HTMLElement;
  /** Wrapper around `#grid` that owns the per-project sub-toolbar. */
  projectPaneHost: HTMLElement;
}

export function getAppElements(): AppElements {
  return {
    gridEl: requireById<HTMLDivElement>("grid", HTMLDivElement),
    sidebarLeft: requireById("sidebar-left"),
    sidebarRight: requireById("sidebar-right"),
    layoutEl: requireById("layout"),
    mainRow: requireById("main-row"),
    rightCol: requireById("right-col"),
    notesGutter: document.getElementById("gutter-notes"),
    notes: getNotesElements(),
    breadcrumbHost: requireById("breadcrumb"),
    projectPaneHost: requireById("project-pane"),
  };
}

import type { TerminalLayoutNode } from "../terminal/terminal-layout";
import type { TerminalSpec } from "../terminal/types";

// What crosses between the main window and a project's own window. The main
// window keeps owning the project and its persistence; the project window
// only renders the grid and reports what changed.

/** Emitted by the project window to `main` on every change. */
export const PROJECT_WINDOW_UPDATE_EVENT = "project-window:update";
/** Emitted by Rust to `main` once a project window is destroyed. */
export const PROJECT_WINDOW_CLOSED_EVENT = "project-window:closed";

export interface ProjectWindowPayload {
  path: string;
  specs: TerminalSpec[];
  layout: TerminalLayoutNode | null;
  activeCliId: string;
}

/** What Rust hands the project window to build itself. */
export interface ProjectWindowState {
  projectId: string;
  title: string;
  payload: ProjectWindowPayload;
}

export interface ProjectWindowUpdate {
  projectId: string;
  specs?: TerminalSpec[];
  layout?: TerminalLayoutNode | null;
  liveCount?: number;
  bell?: { paneId: string; pending: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isProjectWindowUpdate(value: unknown): value is ProjectWindowUpdate {
  if (!isRecord(value) || typeof value.projectId !== "string") return false;
  if ("specs" in value && !Array.isArray(value.specs)) return false;
  if ("liveCount" in value && typeof value.liveCount !== "number") return false;
  if ("bell" in value) {
    const bell = value.bell;
    if (!isRecord(bell) || typeof bell.paneId !== "string" || typeof bell.pending !== "boolean")
      return false;
  }
  return true;
}

export function isProjectWindowClosed(value: unknown): value is { projectId: string } {
  return isRecord(value) && typeof value.projectId === "string";
}

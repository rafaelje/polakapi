import type { TerminalLayoutNode } from "../terminal/terminal-layout";
import type { PaneSnapshot, PaneSnapshots, TerminalSpec } from "../terminal/types";

// What crosses between the main window and a project's own window. The main
// window keeps owning the project and its persistence; the project window
// only renders the grid and reports what changed.

/** Emitted by the project window to `main` on every change. */
export const PROJECT_WINDOW_UPDATE_EVENT = "project-window:update";
/** Emitted by Rust to `main` once a project window is destroyed. */
export const PROJECT_WINDOW_CLOSED_EVENT = "project-window:closed";
/** Sent by `main` to a project window: render this running terminal too. */
export const PROJECT_WINDOW_ADOPT_EVENT = "project-window:adopt";

/** A torn-off terminal is named after its project and its PTY. */
export function paneWindowId(projectId: string, ptyId: string): string {
  return `${projectId}--${ptyId}`;
}

export interface ProjectWindowPayload {
  path: string;
  specs: TerminalSpec[];
  layout: TerminalLayoutNode | null;
  activeCliId: string;
  snapshots?: PaneSnapshots;
}

/** Sent with PROJECT_WINDOW_ADOPT_EVENT. */
export interface AdoptedPane {
  adoptionId: string;
  spec: TerminalSpec;
  snapshot: PaneSnapshot | null;
}

/** What Rust hands the project window to build itself. */
export interface ProjectWindowState {
  /** The project id for a whole grid, `paneWindowId` for one terminal. */
  windowId: string;
  projectId: string;
  title: string;
  payload: ProjectWindowPayload;
  position?: [number, number];
}

export interface ProjectWindowUpdate {
  windowId: string;
  projectId: string;
  specs?: TerminalSpec[];
  layout?: TerminalLayoutNode | null;
  liveCount?: number;
  closing?: boolean;
  /** Confirmed only after the requested panes have finished attaching. */
  adopted?: string[];
  bell?: { paneId: string; pending: boolean };
  /** Sent while the window closes, so the panes come back looking the same. */
  snapshots?: PaneSnapshots;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isProjectWindowUpdate(value: unknown): value is ProjectWindowUpdate {
  if (!isRecord(value) || typeof value.projectId !== "string") return false;
  if (typeof value.windowId !== "string") return false;
  if ("specs" in value && !Array.isArray(value.specs)) return false;
  if ("liveCount" in value && typeof value.liveCount !== "number") return false;
  if ("closing" in value && typeof value.closing !== "boolean") return false;
  if (
    "adopted" in value &&
    (!Array.isArray(value.adopted) || value.adopted.some((id) => typeof id !== "string"))
  )
    return false;
  if ("snapshots" in value && !isRecord(value.snapshots)) return false;
  if ("bell" in value) {
    const bell = value.bell;
    if (!isRecord(bell) || typeof bell.paneId !== "string" || typeof bell.pending !== "boolean")
      return false;
  }
  return true;
}

export function isProjectWindowClosed(value: unknown): value is { windowId: string } {
  return isRecord(value) && typeof value.windowId === "string";
}

export function isAdoptedPane(value: unknown): value is AdoptedPane {
  return (
    isRecord(value) &&
    typeof value.adoptionId === "string" &&
    isRecord(value.spec) &&
    typeof value.spec.id === "string"
  );
}

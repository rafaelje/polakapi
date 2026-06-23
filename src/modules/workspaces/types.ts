import type { TerminalSpec } from "../terminal/types";

export type { TerminalSpec };

// Branded IDs to keep workspace/project identifiers from being mixed up at the
// type level. They are still plain strings at runtime (crypto.randomUUID()).
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
export type ProjectId = string & { readonly __brand: "ProjectId" };

export interface Project {
  id: ProjectId;
  name: string;
  /** Absolute path. Validated at creation time and on startup. */
  path: string;
  icon?: string;
  color?: string;
  /** If undefined, the row is sorted alphabetically by name. */
  order?: number;
  /** Set on startup when fs_validate_path fails for this project. */
  pathInvalid?: boolean;
  /**
   * Persisted terminal specs to spawn on next activation of this project.
   * Optional/additive — projects created before F2 simply have no field.
   */
  terminals?: TerminalSpec[];
  /**
   * Per-project terminal grid columns. When undefined the router falls back to
   * the global default (kept for backward compat with the layout store).
   */
  terminalCols?: number;
}

export interface Workspace {
  id: WorkspaceId;
  name: string;
  color?: string;
  collapsed?: boolean;
  /** If undefined, the workspace is sorted alphabetically by name. */
  order?: number;
  projects: Project[];
}

export interface WorkspacesState {
  workspaces: Workspace[];
  activeProjectId: ProjectId | null;
  schemaVersion: 1;
}

export type PathValidation =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "not_directory" | "not_readable" | "unknown";
      detail?: string;
    };

export interface CreateProjectInput {
  workspaceId: WorkspaceId;
  name: string;
  /** Must already be validated by the caller. */
  path: string;
  icon?: string;
  color?: string;
}

export type WorkspacesEvent =
  | { type: "state-changed"; state: WorkspacesState }
  | { type: "active-project-changed"; project: Project | null };

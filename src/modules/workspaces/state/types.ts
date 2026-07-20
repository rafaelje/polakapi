import type { TerminalSpec } from "../../terminal/types";
import type { TerminalLayoutNode } from "../../terminal/terminal-layout";

export type { TerminalSpec };
export type { TerminalLayoutNode };

// Branded IDs to keep workspace/project identifiers from being mixed up at the
// type level. They are still plain strings at runtime (crypto.randomUUID()).
export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
export type ProjectId = string & { readonly __brand: "ProjectId" };

/**
 * F4: closed set of color tokens applied to workspaces and projects. Kept as a
 * union literal so reducer helpers, the appearance picker and the CSS layer
 * can all rely on the same vocabulary. Persisted as a plain string at
 * runtime — older payloads with arbitrary strings are tolerated by readers
 * (they fall back to the deterministic palette via `deriveFallbackColor`).
 */
export type ColorToken = "slate" | "blue" | "purple" | "pink" | "green" | "orange";

export interface Project {
  id: ProjectId;
  name: string;
  /** Absolute path. Validated at creation time and on startup. */
  path: string;
  color?: ColorToken;
  /** If undefined, the row is sorted alphabetically by name. */
  order?: number;
  /** Set on startup when fs_validate_path fails for this project. */
  pathInvalid?: boolean;
  /**
   * Persisted terminal specs to spawn on next activation of this project.
   * Optional/additive — projects created before F2 simply have no field.
   */
  terminals?: TerminalSpec[];
  terminalLayout?: TerminalLayoutNode;
  /**
   * Per-project default CLI for new panes (chip row selection). Undefined is
   * treated as "shell". Persisted so the chip selection survives restart.
   */
  activeCliId?: string;
  /**
   * F3: per-project notes body. Undefined is treated as ''. Persisted in
   * workspaces.json. Optional/additive — projects created before F3 simply
   * have no field, which readers must treat as the empty string.
   */
  notes?: string;
  /**
   * Single lowercase character bound to Ctrl+Alt+<key> for direct activation.
   * Unique across all projects and workspaces; optional/additive.
   */
  shortcut?: string;
}

export interface Workspace {
  id: WorkspaceId;
  name: string;
  color?: ColorToken;
  collapsed?: boolean;
  /** If undefined, the workspace is sorted alphabetically by name. */
  order?: number;
  /** Same contract as Project.shortcut — activates the workspace's first project. */
  shortcut?: string;
  projects: Project[];
}

/**
 * Template-local terminal spec: everything a pane needs except `cwd` — a
 * template is path-agnostic and always spawns into the target project's path.
 * `id` is referenced by the template's layout tree paneIds.
 */
export interface LayoutTemplateSpec {
  id: string;
  title?: string;
  startupCmd?: string;
  cliId?: string;
}

/**
 * Named, reusable snapshot of a project's terminal arrangement: which CLIs,
 * how many panes, and the split tree (ratios included). Global — applicable
 * to any project.
 */
export interface LayoutTemplate {
  id: string;
  name: string;
  specs: LayoutTemplateSpec[];
  layout: TerminalLayoutNode;
}

export interface WorkspacesState {
  workspaces: Workspace[];
  activeProjectId: ProjectId | null;
  /**
   * Saved layout templates. Optional/additive — states persisted before this
   * feature simply have no field, which readers must treat as an empty list.
   */
  layoutTemplates?: LayoutTemplate[];
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
  color?: ColorToken;
}

export type WorkspacesEvent =
  | { type: "state-changed"; state: WorkspacesState }
  | { type: "active-project-changed"; project: Project | null };

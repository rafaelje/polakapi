export interface PaneCreateOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  cliId?: string;
  /** Render a PTY that is already running (in another window) instead of spawning one. */
  existingPtyId?: string;
  /** What that other window showed, so the pane picks up exactly where it was. */
  snapshot?: PaneSnapshot;
}

/** A pane's screen and scrollback with its colors, and the PTY output offset
 * it covers; output after that offset is replayed on top. */
export interface PaneSnapshot {
  screen: string;
  offset: number;
  cols: number;
  rows: number;
}

/** Pane snapshots by PTY id. */
export type PaneSnapshots = Record<string, PaneSnapshot>;

export interface PaneAddOptions {
  silent?: boolean;
  extraArgs?: string[];
  skipStartupCmd?: boolean;
  splitPosition?: "right" | "bottom";
  adoptPtyId?: string;
  snapshot?: PaneSnapshot;
}

/**
 * Persisted, user-visible description of a terminal that belongs to a project.
 *
 * The `id` is generated client-side with `crypto.randomUUID()` and reused as
 * the `ptyId` once the manager spawns the PTY, so the spec and the live pane
 * share identity across boots.
 *
 * - `title`     — optional, user-renamable pane label.
 * - `cwd`       — when undefined, the manager falls back to its `defaultCwd`
 *                 (i.e. the owning project's `path`).
 * - `startupCmd` — optional one-shot command piped into the shell on spawn.
 * - `cliId`     — optional CLI profile id; undefined resolves to SHELL_PROFILE.
 * - `launchArgs` — optional arguments replacing the selected profile defaults.
 * - `lastShellCommand` — replay-eligible submitted command persisted to disk.
 */
export interface TerminalSpec {
  id: string;
  title?: string;
  cwd?: string;
  startupCmd?: string;
  cliId?: string;
  launchArgs?: string[];
  suspended?: boolean;
  lastShellCommand?: string;
  /** True when the persisted command resolved to a shell alias/function. */
  lastShellCommandAlias?: boolean;
}

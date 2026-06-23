export interface PaneCreateOptions {
  command?: string;
  args?: string[];
  cwd?: string;
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
 */
export interface TerminalSpec {
  id: string;
  title?: string;
  cwd?: string;
  startupCmd?: string;
}

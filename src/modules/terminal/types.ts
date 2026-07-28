export interface PaneCreateOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  cliId?: string;
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
 * - `lastShellCommand` — captured via the shell-integration OSC hook (see
 *   `terminal-shell-integration.ts`): the last Enter-submitted command in
 *   this shell session. Undefined for AI-CLI panes and shells that never ran
 *   a command. Replayed verbatim (with `\r` appended) by `resumePane`/
 *   `resumeAll` for `cliId === "shell"` (or undefined) panes.
 */
export interface TerminalSpec {
  id: string;
  title?: string;
  cwd?: string;
  startupCmd?: string;
  cliId?: string;
  suspended?: boolean;
  lastShellCommand?: string;
}

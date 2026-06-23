/**
 * Callbacks the TerminalManager injects into a TerminalPane so the pane can
 * read and persist its own startup command without holding a reference to the
 * workspaces controller. Lives in its own file to avoid a circular import
 * between terminal-pane.ts and terminal-pane-menu.ts.
 */
export interface StartupCmdEditCallbacks {
  getStartupCmd(): string | undefined;
  onChange(next: string | undefined): void;
}

/**
 * Callbacks driving the CLI badge click → respawn flow. Injected by the
 * TerminalManager so the pane can show the respawn menu without knowing how
 * to swap a PTY in place.
 */
export interface CliRespawnCallbacks {
  getCurrentCliId(): string;
  onRespawnRequest(cliId: string): void;
}

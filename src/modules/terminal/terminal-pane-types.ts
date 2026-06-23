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

import { TerminalPane } from "../terminal/terminal-pane";
import { ptyKill } from "../terminal/pty-client";

// Single persistent shell pane used as the "shell" tab of the bottom panel.
// Lazy-spawns on first activate(), respawns the next time activate() is
// called after the process exits. Not per-project: one global shell.
//
// PTY routing: the AppController's pty:data / pty:exit listeners must call
// handlePtyData / handlePtyExit BEFORE the TerminalRouter so this pane
// receives its own events (the router does not know about it).

export interface ShellPanelOptions {
  /**
   * Returns true while the shell tab is the visible one. Used to gate the
   * deferred refit triggered by attach so we don't push a fit on a host
   * that's been hidden again by a fast tab swap.
   */
  isVisible: () => boolean;
}

export interface ShellPanelHandle {
  /** Lazy-spawn (or respawn after exit), then fit and focus. */
  activate(): void;
  /** Re-measure the pane. No-op if no live pane. */
  refit(): void;
  /** Route a pty:data event. Returns true when consumed. */
  handlePtyData(id: string, data: string): boolean;
  /** Route a pty:exit event. Returns true when consumed. */
  handlePtyExit(id: string): boolean;
  dispose(): Promise<void>;
}

export function mountShellPanel(host: HTMLElement, opts: ShellPanelOptions): ShellPanelHandle {
  let pane: TerminalPane | null = null;
  // Tracked separately from `pane` so a respawn after exit tears down the
  // old instance before creating a fresh one.
  let exited = false;
  let spawning = false;
  let disposed = false;

  const ensure = async (): Promise<void> => {
    if (disposed) return;
    if (pane && !exited) return;
    if (spawning) return;
    spawning = true;
    try {
      if (pane && exited) {
        const stale = pane;
        pane = null;
        exited = false;
        await stale.dispose();
      }
      const next = new TerminalPane();
      pane = next;
      await next.attach(host);
      // The host may have been measured at zero size during attach if the
      // tab was hidden when first opened. Refit on the next frame to pick
      // up the real dimensions — but only if the tab is still visible.
      requestAnimationFrame(() => {
        if (pane === next && opts.isVisible()) next.fit();
      });
    } catch (error) {
      console.error("Failed to spawn bottom shell", error);
    } finally {
      spawning = false;
    }
  };

  return {
    activate: () => {
      if (disposed) return;
      void ensure().then(() => {
        if (disposed || !pane || exited) return;
        if (!opts.isVisible()) return;
        pane.fit();
        pane.focus();
      });
    },
    refit: () => {
      if (disposed || !pane || exited) return;
      pane.fit();
    },
    handlePtyData: (id, data) => {
      if (!pane || pane.ptyId !== id) return false;
      pane.write(data);
      return true;
    },
    handlePtyExit: (id) => {
      if (!pane || pane.ptyId !== id) return false;
      pane.markExited();
      exited = true;
      return true;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      const live = pane;
      pane = null;
      if (live) {
        // Kill PTY eagerly so the Rust side tears down even if dispose throws.
        if (live.ptyId) void ptyKill(live.ptyId);
        await live.dispose();
      }
    },
  };
}

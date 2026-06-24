import { TerminalPane } from "../terminal/terminal-pane";
import { ptyKill } from "../terminal/pty-client";
import { BOTTOM_TABS, isBottomTab, type BottomTab } from "./types";

// ---------------------------------------------------------------------------
// Bottom panel with notes + shell tabs.
//
// The shell is a single persistent TerminalPane instance shared across
// projects (not per-project). It is spawned lazily on first switch to the
// "shell" tab and respawned automatically the next time the user enters
// the tab after the process exits.
//
// PTY routing: AppController's pty:data/pty:exit listeners must consult
// `handlePtyData` / `handlePtyExit` BEFORE the TerminalRouter so the shell
// pane (which the router does not own) receives its own events.
// ---------------------------------------------------------------------------

export interface BottomPanelOptions {
  /** Persist active tab on switch. */
  onTabChange?: (tab: BottomTab) => void;
  /** Initial tab (defaults to "notes"). */
  initialTab?: BottomTab;
}

export interface BottomPanelHandle {
  setActiveTab(tab: BottomTab): void;
  getActiveTab(): BottomTab;
  /** Refit the shell pane if it exists and the shell tab is active. */
  refit(): void;
  /** Route a pty:data event. Returns true when consumed by the shell. */
  handlePtyData(id: string, data: string): boolean;
  /** Route a pty:exit event. Returns true when consumed by the shell. */
  handlePtyExit(id: string): boolean;
  dispose(): Promise<void>;
}

export function mountBottomPanel(opts: BottomPanelOptions = {}): BottomPanelHandle | null {
  const tabButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".bottom-tab[data-tab]"),
  );
  const tabPanels = new Map<BottomTab, HTMLElement>();
  for (const tab of BOTTOM_TABS) {
    const el = document.querySelector<HTMLElement>(`.bottom-tab-panel[data-tab-panel="${tab}"]`);
    if (el) tabPanels.set(tab, el);
  }
  if (tabButtons.length === 0 || tabPanels.size !== BOTTOM_TABS.length) {
    return null;
  }
  const shellHost = tabPanels.get("shell");
  if (!shellHost) return null;

  let activeTab: BottomTab = opts.initialTab ?? "notes";
  let shellPane: TerminalPane | null = null;
  // Tracked separately from `shellPane` so a respawn after exit knows to tear
  // the old instance down before creating a fresh one.
  let shellExited = false;
  let spawning = false;
  let disposed = false;

  const setButtonState = (tab: BottomTab): void => {
    for (const btn of tabButtons) {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    }
  };

  const setPanelVisibility = (tab: BottomTab): void => {
    for (const [key, panel] of tabPanels) {
      panel.hidden = key !== tab;
    }
  };

  const ensureShell = async (): Promise<void> => {
    if (disposed) return;
    if (shellPane && !shellExited) return;
    if (spawning) return;
    spawning = true;
    try {
      if (shellPane && shellExited) {
        const stale = shellPane;
        shellPane = null;
        shellExited = false;
        await stale.dispose();
      }
      const pane = new TerminalPane();
      shellPane = pane;
      await pane.attach(shellHost);
      // The host may have been measured at zero size during attach if the
      // tab was hidden when first opened. Refit on the next frame to pick up
      // the real dimensions.
      requestAnimationFrame(() => {
        if (shellPane === pane && activeTab === "shell") pane.fit();
      });
    } catch (error) {
      console.error("Failed to spawn bottom shell", error);
    } finally {
      spawning = false;
    }
  };

  const setActiveTab = (tab: BottomTab): void => {
    if (disposed) return;
    if (!BOTTOM_TABS.includes(tab)) return;
    const changed = tab !== activeTab;
    activeTab = tab;
    setButtonState(tab);
    setPanelVisibility(tab);
    if (tab === "shell") {
      void ensureShell().then(() => {
        if (activeTab === "shell" && shellPane) {
          shellPane.fit();
          shellPane.focus();
        }
      });
    }
    if (changed) opts.onTabChange?.(tab);
  };

  const onButtonClick = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const tab = target.dataset.tab;
    if (isBottomTab(tab)) setActiveTab(tab);
  };
  for (const btn of tabButtons) {
    btn.addEventListener("click", onButtonClick);
  }

  // Apply initial visual state without firing onTabChange.
  setButtonState(activeTab);
  setPanelVisibility(activeTab);
  if (activeTab === "shell") {
    void ensureShell().then(() => {
      if (activeTab === "shell" && shellPane) shellPane.fit();
    });
  }

  return {
    setActiveTab,
    getActiveTab: () => activeTab,
    refit: () => {
      if (activeTab === "shell" && shellPane && !shellExited) shellPane.fit();
    },
    handlePtyData: (id, data) => {
      if (!shellPane || shellPane.ptyId !== id) return false;
      shellPane.write(data);
      return true;
    },
    handlePtyExit: (id) => {
      if (!shellPane || shellPane.ptyId !== id) return false;
      shellPane.markExited();
      shellExited = true;
      return true;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const btn of tabButtons) {
        btn.removeEventListener("click", onButtonClick);
      }
      const pane = shellPane;
      shellPane = null;
      if (pane) {
        // Kill PTY eagerly so the Rust side tears down even if dispose throws.
        if (pane.ptyId) void ptyKill(pane.ptyId);
        await pane.dispose();
      }
    },
  };
}

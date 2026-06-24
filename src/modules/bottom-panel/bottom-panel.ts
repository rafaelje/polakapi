import { mountShellPanel, type ShellPanelHandle } from "../shell/shell-panel";
import { BOTTOM_TABS, isBottomTab, type BottomTab } from "./types";

// Orchestrates the tab strip + per-tab containers in the bottom panel. The
// notes textarea lives inside `[data-tab-panel="notes"]` and is driven by
// the existing notes-panel module untouched. The shell tab is delegated to
// the shell-panel module, which owns the TerminalPane lifecycle.

export interface BottomPanelOptions {
  /** Persist active tab on switch. */
  onTabChange?: (tab: BottomTab) => void;
  /** Initial tab (defaults to "notes"). */
  initialTab?: BottomTab;
}

export interface BottomPanelHandle {
  setActiveTab(tab: BottomTab): void;
  getActiveTab(): BottomTab;
  /** Refit the shell pane when the bottom panel is resized/toggled. */
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
  let disposed = false;

  const shell: ShellPanelHandle = mountShellPanel(shellHost, {
    isVisible: () => !disposed && activeTab === "shell",
  });

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

  const setActiveTab = (tab: BottomTab): void => {
    if (disposed) return;
    if (!BOTTOM_TABS.includes(tab)) return;
    const changed = tab !== activeTab;
    activeTab = tab;
    setButtonState(tab);
    setPanelVisibility(tab);
    if (tab === "shell") shell.activate();
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
  if (activeTab === "shell") shell.activate();

  return {
    setActiveTab,
    getActiveTab: () => activeTab,
    refit: () => {
      if (activeTab === "shell") shell.refit();
    },
    handlePtyData: (id, data) => shell.handlePtyData(id, data),
    handlePtyExit: (id) => shell.handlePtyExit(id),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const btn of tabButtons) {
        btn.removeEventListener("click", onButtonClick);
      }
      await shell.dispose();
    },
  };
}

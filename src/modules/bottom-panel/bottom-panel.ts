import { mountAgentPanel, type AgentPanelHandle } from "../app-agent/agent-panel";
import { createAgentWindowLink } from "../app-agent/agent-window-link";
import { mountShellPanel, type ShellPanelHandle } from "../shell/shell-panel";
import { mountUsagePanel, type UsagePanelHandle } from "../usage/usage-panel";
import { BOTTOM_TABS, isBottomTab, type BottomTab } from "./types";

// Orchestrates the tab strip + per-tab containers in the bottom panel. The
// notes textarea lives inside `[data-tab-panel="notes"]` and is driven by
// the existing notes-panel module untouched. The shell and agent tabs are
// delegated to the shell-panel and agent-panel modules, which own their
// TerminalPane lifecycle. The usage tab is delegated to the usage-panel
// module, which lazy-loads the Rust `usage_summary` command on first
// activation.

export interface BottomPanelOptions {
  /** Persist active tab on switch. */
  onTabChange?: (tab: BottomTab) => void;
  /** Initial tab (defaults to "notes"). */
  initialTab?: BottomTab;
  /** CLI preselected in the agent tab. */
  initialAgentCli?: string;
  /** Persist the agent tab's CLI choice. */
  onAgentCliChange?: (cli: string) => void;
}

export interface BottomPanelHandle {
  setActiveTab(tab: BottomTab): void;
  getActiveTab(): BottomTab;
  /** Refit the shell or agent pane when the bottom panel is resized/toggled. */
  refit(): void;
  /** Route a pty:data event. Returns true when consumed by the shell or agent pane. */
  handlePtyData(id: string, data: string, offset?: number): boolean;
  /** Route a pty:exit event. Returns true when consumed by the shell or agent pane. */
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
  const agentHost = tabPanels.get("agent");
  const usageHost = tabPanels.get("usage");
  if (!shellHost || !agentHost || !usageHost) return null;

  let activeTab: BottomTab = opts.initialTab ?? "notes";
  let disposed = false;

  const shell: ShellPanelHandle = mountShellPanel(shellHost, {
    isVisible: () => !disposed && activeTab === "shell",
  });
  const agentWindow = createAgentWindowLink({ onCliChange: opts.onAgentCliChange });
  const agent: AgentPanelHandle = mountAgentPanel(agentHost, {
    isVisible: () => !disposed && activeTab === "agent",
    initialCli: opts.initialAgentCli,
    onCliChange: opts.onAgentCliChange,
    detach: agentWindow.actions,
  });
  agentWindow.bind(agent);
  const agentTabButton = tabButtons.find((btn) => btn.dataset.tab === "agent");
  if (agentTabButton) agent.addTearOffHandle(agentTabButton);
  const usage: UsagePanelHandle = mountUsagePanel(usageHost, {
    isVisible: () => !disposed && activeTab === "usage",
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
    if (tab === "agent") agent.activate();
    if (tab === "usage") usage.activate();
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
  if (activeTab === "agent") agent.activate();
  if (activeTab === "usage") usage.activate();

  return {
    setActiveTab,
    getActiveTab: () => activeTab,
    refit: () => {
      if (activeTab === "shell") shell.refit();
      if (activeTab === "agent") agent.refit();
    },
    handlePtyData: (id, data, offset) =>
      shell.handlePtyData(id, data) || agent.handlePtyData(id, data, offset),
    handlePtyExit: (id) => shell.handlePtyExit(id) || agent.handlePtyExit(id),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const btn of tabButtons) {
        btn.removeEventListener("click", onButtonClick);
      }
      usage.dispose();
      agentWindow.dispose();
      await Promise.all([shell.dispose(), agent.dispose()]);
    },
  };
}

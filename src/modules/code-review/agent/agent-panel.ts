import type { UnlistenFn } from "@tauri-apps/api/event";
import { AGENT_CLIS } from "../../../shared/agent-cli";
import { bracketedPaste } from "../../agents-library/compose";
import { onPtyData, onPtyExit, ptyWrite } from "../../terminal/pty-client";
import { TerminalPane } from "../../terminal/terminal-pane";
import { el } from "../dom";
import {
  agentSpawnSpec,
  changeAgentSelection,
  initialAgentSelection,
  shouldRestartAgent,
  type AgentSelection,
  type AgentSelectionChange,
} from "./agent-session";
import { stringifyError } from "../../../shared/errors";

export interface AgentPanel {
  selection(): AgentSelection;
  onSelectionChange(listener: (selection: AgentSelection) => void): void;
  write(text: string): Promise<boolean>;
  dispose(): Promise<void>;
}

const SUBMIT_DELAY_MS = 150;

interface AgentPanelDom {
  toggle: HTMLButtonElement;
  cliSelect: HTMLSelectElement;
  modelInput: HTMLInputElement;
  restartButton: HTMLButtonElement;
  terminalHost: HTMLElement;
}

function renderPanel(host: HTMLElement, selection: AgentSelection): AgentPanelDom {
  const header = el("div", "code-review-agent-header");
  const title = el("div", "code-review-column-title");
  title.textContent = "agent";
  const toggle = el("button", "code-review-agent-toggle");
  toggle.type = "button";

  const controls = el("div", "code-review-agent-controls");
  const cliSelect = el("select", "code-review-agent-cli");
  cliSelect.setAttribute("aria-label", "Agent CLI");
  for (const cli of AGENT_CLIS) cliSelect.append(new Option(cli, cli));
  cliSelect.value = selection.cli;
  const modelInput = el("input", "code-review-agent-model");
  modelInput.type = "text";
  modelInput.spellcheck = false;
  modelInput.placeholder = "model";
  modelInput.setAttribute("aria-label", "Agent model");
  modelInput.value = selection.model;
  const restartButton = el("button", "code-review-agent-restart");
  restartButton.type = "button";
  restartButton.textContent = "↻";
  restartButton.title = "Restart the agent terminal";

  header.append(title, toggle);
  controls.append(cliSelect, modelInput, restartButton);
  const terminalHost = el("div", "code-review-agent-terminal");
  host.replaceChildren(header, controls, terminalHost);
  return { toggle, cliSelect, modelInput, restartButton, terminalHost };
}

export function mountAgentPanel(host: HTMLElement, projectPath: string): AgentPanel {
  let selection = initialAgentSelection();
  let running: AgentSelection | null = null;
  let pane: TerminalPane | null = null;
  let collapsed = false;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const unlisten: Array<Promise<UnlistenFn>> = [];
  const selectionListeners: Array<(selection: AgentSelection) => void> = [];
  const dom = renderPanel(host, selection);

  const fitLive = (): void => {
    if (!collapsed && pane?.ptyId) pane.fit();
  };

  const restart = (force: boolean): void => {
    queue = queue.then(async () => {
      if (disposed || (!force && !shouldRestartAgent(running, selection))) return;
      const target = selection;
      const stale = pane;
      pane = null;
      running = null;
      await stale?.dispose();
      const next = new TerminalPane();
      const spec = agentSpawnSpec(target, projectPath);
      pane = next;
      try {
        await next.attach(dom.terminalHost, spec);
        running = target;
      } catch (error) {
        next.markSpawnFailed(spec.command, stringifyError(error));
      }
      requestAnimationFrame(() => {
        if (pane === next) fitLive();
      });
    });
  };

  const apply = (change: AgentSelectionChange): void => {
    const previous = selection;
    selection = changeAgentSelection(selection, change);
    if (selection !== previous) selectionListeners.forEach((listener) => listener(selection));
    dom.cliSelect.value = selection.cli;
    dom.modelInput.value = selection.model;
    restart(false);
  };

  const setCollapsed = (next: boolean): void => {
    collapsed = next;
    host.classList.toggle("is-collapsed", collapsed);
    host.parentElement?.classList.toggle("is-agent-collapsed", collapsed);
    dom.toggle.textContent = collapsed ? "›" : "‹";
    dom.toggle.title = collapsed ? "Expand the agent panel" : "Collapse the agent panel";
    dom.toggle.setAttribute("aria-expanded", String(!collapsed));
    if (!collapsed) requestAnimationFrame(fitLive);
  };

  dom.toggle.addEventListener("click", () => setCollapsed(!collapsed));
  dom.cliSelect.addEventListener("change", () => apply({ cli: dom.cliSelect.value }));
  dom.modelInput.addEventListener("change", () => apply({ model: dom.modelInput.value }));
  dom.restartButton.addEventListener("click", () => restart(true));
  const resizeObserver = new ResizeObserver(() => requestAnimationFrame(fitLive));
  resizeObserver.observe(dom.terminalHost);

  unlisten.push(
    onPtyData(({ id, data }) => {
      if (pane && pane.ptyId === id) pane.write(data);
    }),
    onPtyExit(({ id }) => {
      if (!pane || pane.ptyId !== id) return;
      pane.markExited();
      running = null;
    }),
  );

  queue = Promise.all(unlisten).catch((error: unknown) => {
    console.error("Failed to listen to the agent terminal", error);
  });
  setCollapsed(false);
  restart(false);

  const write = async (text: string): Promise<boolean> => {
    await queue;
    const target = pane;
    if (disposed || !target?.ptyId || running === null) return false;
    if (collapsed) setCollapsed(false);
    await ptyWrite(target.ptyId, bracketedPaste(text));
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
    if (pane !== target || !target.ptyId) return false;
    await ptyWrite(target.ptyId, "\r");
    target.focus();
    return true;
  };

  return {
    selection: () => selection,
    onSelectionChange: (listener) => selectionListeners.push(listener),
    write,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      resizeObserver.disconnect();
      for (const pending of unlisten) void pending.then((stop) => stop());
      await queue;
      await pane?.dispose();
      pane = null;
    },
  };
}

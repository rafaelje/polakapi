import { invoke } from "../../shared/tauri/invoke";
import { stringifyError } from "../../shared/errors";
import { ptyKill } from "../terminal/pty-client";
import { TerminalPane } from "../terminal/terminal-pane";
import type { AgentLaunchSpec, DetectedCli } from "./types";

// The bottom panel's "agent" tab: pick an installed CLI, run it in polakapi's
// agent home with the polakapi MCP server registered, and talk to it in a
// terminal pane. One pane at a time; switching CLI means stopping the current
// one. Same PTY routing contract as the shell tab (see shell-panel.ts).

export interface AgentPanelOptions {
  isVisible: () => boolean;
  initialCli?: string;
  onCliChange?: (cli: string) => void;
}

export interface AgentPanelHandle {
  activate(): void;
  refit(): void;
  handlePtyData(id: string, data: string): boolean;
  handlePtyExit(id: string): boolean;
  dispose(): Promise<void>;
}

export function mountAgentPanel(host: HTMLElement, opts: AgentPanelOptions): AgentPanelHandle {
  const bar = document.createElement("div");
  bar.className = "agent-panel-bar";
  const label = document.createElement("label");
  label.className = "agent-panel-label";
  label.textContent = "agent";
  const select = document.createElement("select");
  select.className = "agent-panel-select";
  label.append(select);
  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "agent-panel-btn agent-panel-start";
  startBtn.textContent = "Start";
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "agent-panel-btn agent-panel-stop";
  stopBtn.textContent = "Stop";
  stopBtn.hidden = true;
  const status = document.createElement("span");
  status.className = "agent-panel-status";
  bar.append(label, startBtn, stopBtn, status);
  const paneHost = document.createElement("div");
  paneHost.className = "agent-panel-host";
  host.append(bar, paneHost);

  let clis: DetectedCli[] = [];
  let detected = false;
  let detecting: Promise<void> | null = null;
  let pane: TerminalPane | null = null;
  let exited = false;
  let starting = false;
  let disposed = false;
  let selectedCli = opts.initialCli ?? "";

  const setStatus = (text: string, kind: "" | "error" = ""): void => {
    status.textContent = text;
    status.classList.toggle("is-error", kind === "error");
  };

  const renderSelect = (): void => {
    select.replaceChildren();
    const installed = clis.filter((cli) => cli.path !== null);
    for (const cli of clis) {
      const option = document.createElement("option");
      option.value = cli.id;
      option.textContent = cli.path ? cli.label : `${cli.label} (not installed)`;
      option.disabled = cli.path === null;
      select.append(option);
    }
    if (!installed.some((cli) => cli.id === selectedCli)) {
      selectedCli = installed[0]?.id ?? "";
    }
    select.value = selectedCli;
    startBtn.disabled = installed.length === 0;
    if (installed.length === 0) {
      setStatus(
        "No agent CLI found on PATH (claude, codex, cursor-agent, gemini, opencode).",
        "error",
      );
    }
  };

  const detect = (): Promise<void> => {
    if (detected) return Promise.resolve();
    detecting ??= invoke<DetectedCli[]>("agent_cli_detect", {}, { toastOnError: false })
      .then((rows) => {
        clis = rows;
        detected = true;
        renderSelect();
      })
      .catch((error) => {
        setStatus(`Could not detect CLIs: ${stringifyError(error)}`, "error");
      })
      .finally(() => {
        detecting = null;
      });
    return detecting;
  };

  const showRunning = (running: boolean): void => {
    startBtn.hidden = running;
    stopBtn.hidden = !running;
    select.disabled = running;
  };

  const teardownPane = async (): Promise<void> => {
    const live = pane;
    pane = null;
    exited = false;
    if (!live) return;
    if (live.ptyId) void ptyKill(live.ptyId);
    await live.dispose();
  };

  const start = async (): Promise<void> => {
    if (disposed || starting || !selectedCli) return;
    starting = true;
    setStatus("");
    try {
      await teardownPane();
      const spec = await invoke<AgentLaunchSpec>(
        "agent_home_prepare",
        { cli: selectedCli },
        { toastOnError: false },
      );
      const next = new TerminalPane();
      pane = next;
      exited = false;
      showRunning(true);
      await next.attach(paneHost, {
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        cliId: spec.cli,
      });
      requestAnimationFrame(() => {
        if (pane === next && opts.isVisible()) {
          next.fit();
          next.focus();
        }
      });
    } catch (error) {
      setStatus(`Could not start ${selectedCli}: ${stringifyError(error)}`, "error");
      await teardownPane();
      showRunning(false);
    } finally {
      starting = false;
    }
  };

  const stop = async (): Promise<void> => {
    await teardownPane();
    showRunning(false);
    setStatus("");
  };

  const onStart = (): void => {
    void start();
  };
  const onStop = (): void => {
    void stop();
  };
  const onSelect = (): void => {
    selectedCli = select.value;
    opts.onCliChange?.(selectedCli);
  };
  startBtn.addEventListener("click", onStart);
  stopBtn.addEventListener("click", onStop);
  select.addEventListener("change", onSelect);

  return {
    activate: () => {
      if (disposed) return;
      void detect().then(() => {
        if (disposed || !pane || exited || !opts.isVisible()) return;
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
      showRunning(false);
      setStatus(`${selectedCli} exited. Start again to relaunch.`);
      return true;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      startBtn.removeEventListener("click", onStart);
      stopBtn.removeEventListener("click", onStop);
      select.removeEventListener("change", onSelect);
      await teardownPane();
    },
  };
}

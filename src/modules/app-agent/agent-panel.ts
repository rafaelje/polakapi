import { invoke } from "../../shared/tauri/invoke";
import { stringifyError } from "../../shared/errors";
import { ptyKill } from "../terminal/pty-client";
import { TerminalPane } from "../terminal/terminal-pane";
import { attachTearOffDrag } from "./tear-off-drag";
import { mountVoiceControl } from "./voice-control";
import type { AgentHandoff, AgentLaunchSpec, DetectedCli } from "./types";

// The bottom panel's "agent" tab: pick an installed CLI, run it in polakapi's
// agent home with the polakapi MCP server registered, and talk to it in a
// terminal pane. One pane at a time; switching CLI means stopping the current
// one. Same PTY routing contract as the shell tab (see shell-panel.ts).
// The same panel runs in the agent's own window; `release` and `adopt` hand
// the running PTY between the two without stopping it.

export interface AgentPanelOptions {
  isVisible: () => boolean;
  initialCli?: string;
  onCliChange?: (cli: string) => void;
  /** Every start, stop and exit, so whoever holds the agent knows its PTY. */
  onSessionChange?: (handoff: AgentHandoff) => void;
  /** Main window only: moving the agent to its own window and back. */
  detach?: AgentDetachActions;
}

export interface AgentDetachActions {
  open(at?: { x: number; y: number }): void;
  focus(): void;
  bringBack(): void;
}

export interface AgentPanelHandle {
  activate(): void;
  refit(): void;
  handlePtyData(id: string, data: string, offset?: number): boolean;
  handlePtyExit(id: string): boolean;
  /** Drag handles that tear the agent off into its own window. */
  addTearOffHandle(handle: HTMLElement): void;
  /** Lets go of the running agent, keeping its PTY alive; waits for one that is starting. */
  release(): Promise<AgentHandoff | null>;
  adopt(handoff: AgentHandoff): Promise<void>;
  /** Swaps the tab for a note while the agent lives in its own window. */
  setDetached(detached: boolean): void;
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
  const voiceLog = document.createElement("div");
  const paneHost = document.createElement("div");
  paneHost.className = "agent-panel-host";
  host.append(bar, voiceLog, paneHost);

  const tearOffs: Array<{ dispose(): void }> = [];
  const detach = opts.detach;
  const detachedNote = document.createElement("div");
  detachedNote.className = "agent-panel-detached";
  detachedNote.hidden = true;
  if (detach) {
    const windowBtn = document.createElement("button");
    windowBtn.type = "button";
    windowBtn.className = "agent-panel-btn agent-panel-window";
    windowBtn.textContent = "Open in new window";
    windowBtn.title = "Open in new window (or drag this bar out of the window)";
    windowBtn.addEventListener("click", () => detach.open());
    windowBtn.dataset.noDrag = "";
    bar.append(windowBtn);
    tearOffs.push(attachTearOffDrag(bar, (x, y) => detach.open({ x, y })));

    const text = document.createElement("p");
    text.textContent = "The agent is open in its own window.";
    const showBtn = document.createElement("button");
    showBtn.type = "button";
    showBtn.className = "agent-panel-btn";
    showBtn.textContent = "Show window";
    showBtn.addEventListener("click", () => detach.focus());
    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "agent-panel-btn";
    backBtn.textContent = "Bring back";
    backBtn.addEventListener("click", () => detach.bringBack());
    const actions = document.createElement("div");
    actions.className = "agent-panel-detached-actions";
    actions.append(showBtn, backBtn);
    detachedNote.append(text, actions);
    host.append(detachedNote);
  }
  for (const button of [startBtn, stopBtn]) button.dataset.noDrag = "";

  let clis: DetectedCli[] = [];
  let detected = false;
  let detecting: Promise<void> | null = null;
  let pane: TerminalPane | null = null;
  let exited = false;
  let starting: Promise<void> | null = null;
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

  const report = (): void => {
    opts.onSessionChange?.({
      cli: selectedCli,
      session: pane?.ptyId ? { ptyId: pane.ptyId, exited, snapshot: null } : null,
    });
  };

  const teardownPane = async (): Promise<void> => {
    const live = pane;
    pane = null;
    exited = false;
    if (!live) return;
    if (live.ptyId) void ptyKill(live.ptyId);
    await live.dispose();
  };

  const start = (): Promise<void> => {
    if (disposed || starting || !selectedCli) return starting ?? Promise.resolve();
    starting = launch().finally(() => {
      starting = null;
    });
    return starting;
  };

  const launch = async (): Promise<void> => {
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
      report();
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
    }
  };

  const stop = async (): Promise<void> => {
    await teardownPane();
    showRunning(false);
    setStatus("");
    report();
  };

  const release = async (): Promise<AgentHandoff | null> => {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    while (starting) await starting;
    if (disposed) return null;
    const live = pane;
    pane = null;
    const session = live?.ptyId
      ? { ptyId: live.ptyId, exited, snapshot: await live.snapshot() }
      : null;
    exited = false;
    await live?.dispose({ keepPty: true });
    showRunning(false);
    setStatus("");
    return { cli: selectedCli, session };
  };

  const adopt = async (handoff: AgentHandoff): Promise<void> => {
    if (disposed) return;
    await detect();
    await teardownPane();
    if (handoff.cli && clis.some((cli) => cli.id === handoff.cli && cli.path !== null)) {
      selectedCli = handoff.cli;
      select.value = selectedCli;
    }
    const session = handoff.session;
    if (!session) {
      showRunning(false);
      return;
    }
    const next = new TerminalPane();
    pane = next;
    exited = false;
    showRunning(true);
    try {
      await next.attach(paneHost, {
        existingPtyId: session.ptyId,
        snapshot: session.snapshot ?? undefined,
        cliId: handoff.cli,
      });
    } catch (error) {
      setStatus(`Could not pick up ${handoff.cli}: ${stringifyError(error)}`, "error");
    }
    if (pane !== next) return;
    if (session.exited || next.isExited) {
      next.markExited();
      exited = true;
      showRunning(false);
      setStatus(`${selectedCli} exited. Start again to relaunch.`);
    }
    report();
    requestAnimationFrame(() => {
      if (pane === next && !exited && opts.isVisible()) {
        next.fit();
        next.focus();
      }
    });
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
    report();
  };
  startBtn.addEventListener("click", onStart);
  stopBtn.addEventListener("click", onStop);
  select.addEventListener("change", onSelect);
  const voice = mountVoiceControl({
    after: stopBtn,
    log: voiceLog,
    agent: () => ({ cli: selectedCli, ptyId: (!exited && pane?.ptyId) || null }),
  });

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
    handlePtyData: (id, data, offset) => {
      if (!pane || pane.ptyId !== id) return false;
      pane.write(data, offset);
      return true;
    },
    handlePtyExit: (id) => {
      if (!pane || pane.ptyId !== id) return false;
      pane.markExited();
      exited = true;
      showRunning(false);
      setStatus(`${selectedCli} exited. Start again to relaunch.`);
      report();
      return true;
    },
    addTearOffHandle: (handle) => {
      if (!detach) return;
      tearOffs.push(attachTearOffDrag(handle, (x, y) => detach.open({ x, y })));
    },
    release,
    adopt,
    setDetached: (detached) => {
      bar.hidden = detached;
      voiceLog.classList.toggle("is-detached", detached);
      paneHost.hidden = detached;
      detachedNote.hidden = !detached;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const tearOff of tearOffs.splice(0)) tearOff.dispose();
      startBtn.removeEventListener("click", onStart);
      stopBtn.removeEventListener("click", onStop);
      select.removeEventListener("change", onSelect);
      voice.dispose();
      await teardownPane();
    },
  };
}

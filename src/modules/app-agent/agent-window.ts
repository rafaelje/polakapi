import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "../../shared/tauri/invoke";
import { onPtyData, onPtyExit } from "../terminal/pty-client";
import { mountAgentPanel } from "./agent-panel";
import { AGENT_WINDOW_UPDATE_EVENT, isAgentHandoff, type AgentHandoff } from "./types";
import "./agent-window.css";

// The bottom panel's agent tab in its own native window. The agent's PTY was
// started by the main window and keeps running; this window renders it, may
// start or stop agents itself, and hands whatever runs back to `main` when it
// closes.

async function start(): Promise<void> {
  const host = document.querySelector<HTMLElement>("#agent")!;
  const state = await invoke<{ payload: unknown }>("agent_window_state");
  if (!isAgentHandoff(state.payload)) throw new Error("unexpected agent window state");
  const handoff = state.payload;

  const send = (update: AgentHandoff): Promise<void> =>
    emitTo("main", AGENT_WINDOW_UPDATE_EVENT, update).catch((error: unknown) =>
      console.error("agent window: could not reach main", error),
    );

  const panel = mountAgentPanel(host, {
    isVisible: () => true,
    initialCli: handoff.cli,
    onSessionChange: (update) => void send(update),
  });

  let closing: Promise<void> | null = null;
  const currentWindow = getCurrentWebviewWindow();
  // Listen before adopting, so nothing printed during the takeover is lost.
  await Promise.all([
    onPtyData(({ id, data, offset }) => {
      panel.handlePtyData(id, data, offset);
    }),
    onPtyExit(({ id }) => {
      panel.handlePtyExit(id);
    }),
    // Hands main what the agent shows before the window goes, so it comes
    // back with its colors instead of a raw replay.
    currentWindow.onCloseRequested(() => {
      closing ??= (async () => {
        document.body.inert = true;
        try {
          const released = await panel.release();
          if (released) await send(released);
        } catch (error) {
          console.error("agent window: could not hand the agent back", error);
        }
      })();
      return closing;
    }),
  ]);
  await panel.adopt(handoff);
  panel.activate();
  new ResizeObserver(() => panel.refit()).observe(host);
}

void start().catch((error: unknown) => {
  const host = document.querySelector<HTMLElement>("#agent");
  if (!host) return;
  const message = document.createElement("p");
  message.className = "agent-window-error";
  message.textContent = `Could not open the agent: ${String(error)}`;
  host.replaceChildren(message);
});

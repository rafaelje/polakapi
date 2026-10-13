import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "../../shared/tauri/invoke";
import type { AgentDetachActions, AgentPanelHandle } from "./agent-panel";
import {
  AGENT_WINDOW_CLOSED_EVENT,
  AGENT_WINDOW_UPDATE_EVENT,
  isAgentHandoff,
  type AgentHandoff,
} from "./types";

// Main-window side of the agent tab living in its own window. Hands the
// running agent over, keeps the last state the window reported, and takes the
// agent back into the tab when the window closes. The process never stops.

export interface AgentWindowLink {
  actions: AgentDetachActions;
  /** Binds the tab's panel; called once it is mounted. */
  bind(panel: AgentPanelHandle): void;
  dispose(): void;
}

export function createAgentWindowLink(opts: {
  onCliChange?: (cli: string) => void;
}): AgentWindowLink {
  let panel: AgentPanelHandle | null = null;
  let detached = false;
  let opening = false;
  let disposed = false;
  let last: AgentHandoff | null = null;
  const unlisten: UnlistenFn[] = [];

  const takeBack = async (): Promise<void> => {
    if (!detached || !panel) return;
    detached = false;
    const handoff = last;
    last = null;
    panel.setDetached(false);
    if (handoff) await panel.adopt(handoff);
  };

  const open = async (at?: { x: number; y: number }): Promise<void> => {
    if (!panel || disposed) return;
    if (detached) {
      await invoke("agent_window_focus", {}, { toastOnError: false });
      return;
    }
    if (opening) return;
    opening = true;
    try {
      const handoff = await panel.release();
      if (!handoff) return;
      last = handoff;
      detached = true;
      panel.setDetached(true);
      try {
        await invoke(
          "agent_window_open",
          { state: { payload: handoff, position: at ? [at.x, at.y] : null } },
          { toastOnError: true },
        );
      } catch {
        await takeBack();
      }
    } finally {
      opening = false;
    }
  };

  void Promise.all([
    listen(AGENT_WINDOW_UPDATE_EVENT, ({ payload }) => {
      if (!detached || !isAgentHandoff(payload)) return;
      if (payload.cli !== last?.cli) opts.onCliChange?.(payload.cli);
      last = payload;
    }),
    listen(AGENT_WINDOW_CLOSED_EVENT, () => {
      void takeBack().catch((error: unknown) =>
        console.error("agent window: could not take the agent back", error),
      );
    }),
  ])
    .then((fns) => {
      if (disposed) fns.forEach((fn) => fn());
      else unlisten.push(...fns);
    })
    .catch((error: unknown) => console.warn("agent window events unavailable", error));

  return {
    actions: {
      open: (at) => {
        void open(at).catch((error: unknown) =>
          console.error("agent window: could not open", error),
        );
      },
      focus: () => {
        void invoke("agent_window_focus", {}, { toastOnError: false });
      },
      bringBack: () => {
        // Closing the window is what brings the agent back (see takeBack).
        void invoke("agent_window_close", {}, { toastOnError: true });
      },
    },
    bind: (next) => {
      panel = next;
    },
    dispose: () => {
      disposed = true;
      for (const fn of unlisten.splice(0)) fn();
    },
  };
}

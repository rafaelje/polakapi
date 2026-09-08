import { listen } from "@tauri-apps/api/event";
import { invoke } from "../../shared/tauri/invoke";
import {
  defaults,
  loadPreferences,
  watchPreferences,
  type NotificationPreferences,
} from "./preferences";
import { deliverNotification } from "./notifications";

export interface AgentEvent {
  ptyId: string;
  kind: "started" | "finished" | "ended" | "permission" | "waiting";
  cli: string;
}

export class AgentNotificationPolicy {
  private active = new Set<string>();
  private pending = new Map<string, AgentEvent>();
  private last = new Map<string, string>();

  process(events: AgentEvent[], p: NotificationPreferences): AgentEvent[] {
    const notifications: AgentEvent[] = [];
    for (const event of events) {
      const { ptyId, kind } = event;
      if (kind === "started") {
        this.active.add(ptyId);
        this.pending.delete(ptyId);
        this.last.delete(ptyId);
        continue;
      }
      this.active.delete(ptyId);
      if (kind === "ended") {
        for (const id of this.active)
          if (id.startsWith(`${ptyId}:subagent:`)) this.active.delete(id);
        this.last.delete(ptyId);
        continue;
      }
      if (this.last.get(ptyId) === kind) continue;
      this.last.set(ptyId, kind);
      if (kind === "finished" && p.finished === "idle") this.pending.set(ptyId, event);
      else if (
        (kind === "finished" && p.finished === "immediately") ||
        (kind === "permission" && p.permission)
      )
        notifications.push(event);
      else if (kind === "waiting" && p.waiting && this.active.size === 0) notifications.push(event);
    }
    if (p.finished !== "idle") this.pending.clear();
    if (this.active.size === 0) {
      notifications.push(...this.pending.values());
      this.pending.clear();
    }
    return notifications.filter((event) => event.kind !== "waiting" || this.active.size === 0);
  }
}

export async function startAgentNotifier(): Promise<() => void> {
  let preferences = { ...defaults };
  let disposed = false;
  const policy = new AgentNotificationPolicy();
  const unwatch = await watchPreferences((p) => {
    preferences = p;
  });
  preferences = await loadPreferences();
  const [unlisten, unlistenLoop] = await Promise.all([
    listen<{ id: string }>("pty:exit", (event) => {
      policy
        .process([{ ptyId: event.payload.id, kind: "ended", cli: "Agent" }], preferences)
        .forEach(notify);
    }),
    listen<AgentEvent>("agent-lifecycle", (event) => {
      if (!disposed) policy.process([event.payload], preferences).forEach(notify);
    }),
  ]);
  function notify(event: AgentEvent): void {
    const message =
      event.kind === "permission"
        ? "Agent needs permission"
        : event.kind === "waiting"
          ? "Agent waiting for input"
          : "Agent finished";
    void deliverNotification(`polakapi · ${event.cli}`, message, preferences).catch(
      (error: unknown) => console.warn("Agent notification failed", error),
    );
  }
  let timer: ReturnType<typeof setTimeout>;
  const poll = async (): Promise<void> => {
    try {
      const events = await invoke<AgentEvent[]>("notification_events", undefined, {
        toastOnError: false,
      });
      if (!disposed) policy.process(events, preferences).forEach(notify);
    } catch (error) {
      console.warn("Agent event polling failed", error);
    } finally {
      if (!disposed)
        timer = setTimeout(() => {
          void poll();
        }, 1000);
    }
  };
  void poll();
  return () => {
    disposed = true;
    clearTimeout(timer);
    unwatch();
    unlisten();
    unlistenLoop();
  };
}

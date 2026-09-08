import { load } from "@tauri-apps/plugin-store";
import { emit, listen } from "@tauri-apps/api/event";

export interface NotificationPreferences {
  permission: boolean;
  finished: "never" | "immediately" | "idle";
  waiting: boolean;
  desktop: boolean;
  sound: string;
}

export const defaults: NotificationPreferences = {
  permission: true,
  finished: "idle",
  waiting: true,
  desktop: true,
  sound: "default",
};

export function normalizePreferences(value: unknown): NotificationPreferences {
  const p = (value && typeof value === "object" ? value : {}) as Partial<NotificationPreferences>;
  return {
    permission: typeof p.permission === "boolean" ? p.permission : defaults.permission,
    finished: p.finished === "never" || p.finished === "immediately" ? p.finished : "idle",
    waiting: typeof p.waiting === "boolean" ? p.waiting : defaults.waiting,
    desktop: typeof p.desktop === "boolean" ? p.desktop : defaults.desktop,
    sound: typeof p.sound === "string" ? p.sound : defaults.sound,
  };
}

const store = () => load("notifications.json", { autoSave: false, defaults: {} });

export async function loadPreferences(): Promise<NotificationPreferences> {
  return normalizePreferences(await (await store()).get("preferences"));
}

export async function savePreferences(preferences: NotificationPreferences): Promise<void> {
  const db = await store();
  await db.set("preferences", preferences);
  await db.save();
  await emit("notification-preferences", preferences);
}

export function watchPreferences(
  onChange: (p: NotificationPreferences) => void,
): Promise<() => void> {
  return listen("notification-preferences", (event) =>
    onChange(normalizePreferences(event.payload)),
  );
}

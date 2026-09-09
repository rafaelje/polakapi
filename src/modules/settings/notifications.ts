import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { invoke } from "../../shared/tauri/invoke";
import { loadPreferences, type NotificationPreferences } from "./preferences";

export type NotificationEvent =
  | "notification"
  | "permission"
  | "finished"
  | "waiting"
  | "bell"
  | "test";

export function runNotificationCommand(
  command: string,
  title: string,
  body: string,
  event: NotificationEvent,
  toastOnError = true,
): Promise<void> {
  return invoke(
    "notification_run_command",
    { command, title, body, event },
    {
      toastOnError,
      errorMessage: "Notification command failed. Check App Settings.",
    },
  );
}

export async function deliverNotification(
  title: string,
  body: string,
  preferences?: NotificationPreferences,
  event: NotificationEvent = "notification",
): Promise<void> {
  const p = preferences ?? (await loadPreferences());
  const tasks: Promise<unknown>[] = [];
  if (p.command.trim()) {
    tasks.push(runNotificationCommand(p.command, title, body, event));
  }
  if (p.desktop) {
    tasks.push(
      (async () => {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted)
          await invoke(
            "notification_send",
            { title, body, defaultSound: p.sound === "default" },
            { toastOnError: false },
          );
      })(),
    );
  }
  if (p.sound !== "default" && p.sound !== "none") {
    tasks.push(invoke("notification_play_sound", { path: p.sound }, { toastOnError: false }));
  }
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

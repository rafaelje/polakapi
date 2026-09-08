import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { invoke } from "../../shared/tauri/invoke";
import { loadPreferences, type NotificationPreferences } from "./preferences";

export async function deliverNotification(
  title: string,
  body: string,
  preferences?: NotificationPreferences,
): Promise<void> {
  const p = preferences ?? (await loadPreferences());
  const tasks: Promise<unknown>[] = [];
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

import { fetchUpdateCheck } from "./update-check";
import { confirmModal } from "../../shared/ui/modal";
import { showToast } from "../../shared/ui/toast";
import { invoke } from "../../shared/tauri/invoke";

let checking = false;

export async function checkForUpdatesManually(): Promise<void> {
  if (checking) return;
  checking = true;
  showToast("Checking for updates…", "info");
  try {
    const result = await fetchUpdateCheck();
    if (!result.updateAvailable) {
      showToast(`polakapi v${result.currentVersion} is up to date`, "success");
      return;
    }
    if (
      await confirmModal({
        title: `polakapi v${result.latestVersion} is available`,
        message: `You’re running v${result.currentVersion}. Open the release page to download the update.`,
        confirmLabel: "Open release page",
        cancelLabel: "Later",
      })
    )
      await invoke("open_url", { url: result.releaseUrl });
  } catch {
    showToast("Could not check for updates. Check your connection and try again.", "error");
  } finally {
    checking = false;
  }
}

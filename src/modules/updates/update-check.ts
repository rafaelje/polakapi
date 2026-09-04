import { invoke } from "../../shared/tauri/invoke";
import { loadLayout, queueSave } from "../../shared/persistence/store";
import { showToast } from "../../shared/ui/toast";

// Polls the latest GitHub release and surfaces a toolbar chip when it is
// newer than the running build. Clicking the chip opens the release page;
// the close affordance hides that version until an even newer one ships.

export interface UpdateCheck {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

export interface UpdateIndicatorDeps {
  check(): Promise<UpdateCheck>;
  openUrl(url: string): Promise<void>;
  loadDismissed(): Promise<string | undefined>;
  saveDismissed(version: string): void;
  notify(message: string): void;
  /** Delay before the first check so startup work is not competing with it. */
  initialDelayMs?: number;
  intervalMs?: number;
}

export interface UpdateIndicatorHandle {
  refresh(): Promise<void>;
  dispose(): void;
}

const INITIAL_DELAY_MS = 15_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

export function fetchUpdateCheck(): Promise<UpdateCheck> {
  return invoke<UpdateCheck>("update_check", undefined, { toastOnError: false });
}

export function mountUpdateIndicator(
  host: HTMLElement,
  deps: UpdateIndicatorDeps,
): UpdateIndicatorHandle {
  host.replaceChildren();
  host.hidden = true;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "update-chip";
  const label = document.createElement("span");
  label.className = "update-chip-label";
  const dismiss = document.createElement("span");
  dismiss.className = "update-chip-dismiss";
  dismiss.textContent = "×";
  dismiss.title = "Hide until the next release";
  dismiss.setAttribute("role", "button");
  dismiss.setAttribute("aria-label", "Hide update notice");
  button.append(label, dismiss);
  host.append(button);

  let disposed = false;
  let inFlight = false;
  let dismissedVersion: string | undefined;
  let announcedVersion: string | undefined;
  let latest: UpdateCheck | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  const render = (): void => {
    const visible =
      latest !== null && latest.updateAvailable && latest.latestVersion !== dismissedVersion;
    host.hidden = !visible;
    if (!visible || !latest) return;
    label.textContent = `v${latest.latestVersion} available`;
    button.title = `polakapi v${latest.latestVersion} is available (you run v${latest.currentVersion}). Click to open the release.`;
  };

  const run = async (): Promise<void> => {
    if (disposed || inFlight) return;
    inFlight = true;
    try {
      const result = await deps.check();
      if (disposed) return;
      latest = result;
      render();
      if (
        result.updateAvailable &&
        result.latestVersion !== dismissedVersion &&
        result.latestVersion !== announcedVersion
      ) {
        announcedVersion = result.latestVersion;
        deps.notify(`polakapi v${result.latestVersion} is available`);
      }
    } catch {
      // Offline or rate-limited: keep whatever we showed last and retry later.
    } finally {
      inFlight = false;
    }
  };

  button.addEventListener("click", (event) => {
    if (!latest) return;
    if (event.target === dismiss) {
      dismissedVersion = latest.latestVersion;
      deps.saveDismissed(latest.latestVersion);
      render();
      return;
    }
    void deps.openUrl(latest.releaseUrl);
  });

  const ready = deps.loadDismissed().then((version) => {
    if (disposed) return;
    dismissedVersion = version;
    render();
  });

  initialTimer = setTimeout(() => {
    initialTimer = null;
    void ready.then(run);
  }, deps.initialDelayMs ?? INITIAL_DELAY_MS);
  intervalTimer = setInterval(() => {
    if (!document.hidden) void run();
  }, deps.intervalMs ?? INTERVAL_MS);

  return {
    refresh: () => ready.then(run),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (initialTimer !== null) clearTimeout(initialTimer);
      if (intervalTimer !== null) clearInterval(intervalTimer);
      host.replaceChildren();
      host.hidden = true;
    },
  };
}

export function mountUpdateIndicatorWithDefaults(host: HTMLElement): UpdateIndicatorHandle {
  return mountUpdateIndicator(host, {
    check: fetchUpdateCheck,
    openUrl: (url) =>
      invoke<void>("open_url", { url }, { errorMessage: "Failed to open release page" }),
    loadDismissed: async () => (await loadLayout()).dismissedUpdateVersion,
    saveDismissed: (version) => queueSave({ dismissedUpdateVersion: version }),
    notify: (message) => showToast(message, "info"),
  });
}

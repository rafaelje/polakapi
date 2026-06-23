import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { ProjectId } from "../workspaces/types";
import type { TerminalPane } from "./terminal-pane";

/**
 * F5: per-pane bell notification wiring.
 *
 * Behaviour matrix (driven by `isActiveAndFocused`):
 *   - true  → skip OS notification AND skip the sidebar badge (the user
 *             already has the bell in view).
 *   - false → always set `onPendingBell(true)` so the project-row badge lights
 *             up; additionally fire an OS notification when throttle allows.
 *
 * Throttling: a per-pane Map<paneId, lastTs> blocks notifications fired less
 * than `throttleMs` apart (default 3000). The badge does NOT honour the
 * throttle — every bell should still light the row up; the bootstrap clears
 * it when the project becomes active.
 *
 * Permission handling: `requestPermission` is awaited lazily on the first
 * bell that needs an OS notification. The result is cached in a module-level
 * boolean; a denial logs once and degrades silently to badge-only.
 */
export interface BellNotificationOptions {
  pane: TerminalPane;
  paneId: string;
  projectId: ProjectId;
  /** Late-bound so renames propagate without re-registering. */
  getProjectName(): string;
  /** Late-bound so terminal title edits propagate. */
  getTerminalTitle(): string;
  /** When true the bell is skipped entirely (badge + OS notification). */
  isActiveAndFocused(): boolean;
  /** Drives the sidebar badge. The bootstrap clears it on activation. */
  onPendingBell(pending: boolean): void;
  /** Defaults to 3000ms. Per-pane minimum gap between OS notifications. */
  throttleMs?: number;
}

export interface BellNotificationHandle {
  dispose(): void;
}

const DEFAULT_THROTTLE_MS = 3000;

/** Cached permission state. `null` ⇒ not asked yet. */
let permissionGranted: boolean | null = null;
let permissionDeniedWarned = false;
let pendingPermissionRequest: Promise<boolean> | null = null;

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted !== null) return permissionGranted;
  if (pendingPermissionRequest) return pendingPermissionRequest;
  pendingPermissionRequest = (async () => {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === "granted";
      }
      permissionGranted = granted;
      if (!granted && !permissionDeniedWarned) {
        permissionDeniedWarned = true;
        console.warn(
          "[terminal-notifications] OS notification permission denied — degrading to in-app badge only.",
        );
      }
      return granted;
    } catch (error) {
      // Linux notify-osd / dunst quirks can throw here; treat as denied but
      // do not block the bell pipeline.
      if (!permissionDeniedWarned) {
        permissionDeniedWarned = true;
        console.warn("[terminal-notifications] permission probe failed", error);
      }
      permissionGranted = false;
      return false;
    } finally {
      pendingPermissionRequest = null;
    }
  })();
  return pendingPermissionRequest;
}

export function registerBellNotification(opts: BellNotificationOptions): BellNotificationHandle {
  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  let lastOsNotificationTs = 0;
  let disposed = false;

  // Subscribe to xterm's onBell. The pane exposes a thin wrapper that
  // collects the disposable so we don't need to reach into term directly.
  const bellDisposable = opts.pane.onBell(() => {
    if (disposed) return;
    if (opts.isActiveAndFocused()) return;

    // Always raise the sidebar badge — coalescing happens at the
    // bell-pending listener layer (rapid bells → single setBellPending(true)).
    try {
      opts.onPendingBell(true);
    } catch (error) {
      console.error("[terminal-notifications] onPendingBell threw", error);
    }

    // Throttle OS notifications independently of the badge.
    const now = Date.now();
    if (now - lastOsNotificationTs < throttleMs) return;
    lastOsNotificationTs = now;

    void (async () => {
      const granted = await ensurePermission();
      if (!granted || disposed) return;
      try {
        sendNotification({
          title: `${opts.getProjectName()} · ${opts.getTerminalTitle()}`,
          body: "Terminal bell",
        });
      } catch (error) {
        console.error("[terminal-notifications] sendNotification failed", error);
      }
    })();
  });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      bellDisposable.dispose();
    },
  };
}

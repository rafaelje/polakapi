import { invoke } from "../../shared/tauri/invoke";
import { confirmModal } from "../../shared/ui/modal";
import { showToast } from "../../shared/ui/toast";
import { loadContextMode, watchContextMode } from "../settings/context-mode-preferences";

// Context mode data a project has persisted in `.polakapi/`, and the action that
// lets the user delete it from the project actions menu.

export interface ProjectData {
  sessions: number;
  bytes: number;
}

export interface ContextModeActivity {
  /** Whether context mode is switched on right now, as last saved in Settings. */
  isActive(): boolean;
  dispose(): void;
}

/**
 * Follows the master switch across windows: Settings saves in its own window
 * and broadcasts, and the actions menu here has to reflect it without a reload.
 */
export async function trackContextModeActivity(): Promise<ContextModeActivity> {
  let active = false;
  let stop: (() => void) | null = null;
  try {
    active = (await loadContextMode()).enabled;
    stop = await watchContextMode((preferences) => {
      active = preferences.enabled;
    });
  } catch {
    // A store that cannot be read means the action simply stays hidden.
  }
  return {
    isActive: () => active,
    dispose: () => stop?.(),
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function describeData(data: ProjectData): string {
  const sessions = data.sessions === 1 ? "1 session" : `${data.sessions} sessions`;
  return `${sessions}, ${formatBytes(data.bytes)}`;
}

/** Shows what would be deleted, asks, then deletes. Every outcome is reported. */
export async function clearProjectContextData(project: {
  name: string;
  path: string;
}): Promise<void> {
  const found = await invoke<ProjectData>(
    "ctx_project_data_summary",
    { projectPath: project.path },
    { toastOnError: true, errorMessage: "Could not read context mode data" },
  );
  if (found.sessions === 0) {
    showToast(`No context mode data stored in ${project.name}.`, "info");
    return;
  }

  const confirmed = await confirmModal({
    title: "Clear context mode data?",
    message:
      `This deletes ${describeData(found)} stored in ${project.name}/.polakapi. ` +
      "Agents in this project lose access to the output they offloaded there, " +
      "including sessions still open. This cannot be undone.",
    confirmLabel: "Delete data",
    cancelLabel: "Cancel",
    danger: true,
  });
  if (!confirmed) return;

  const removed = await invoke<ProjectData>(
    "ctx_clear_project_data",
    { projectPath: project.path },
    { toastOnError: true, errorMessage: "Could not delete context mode data" },
  );
  showToast(`Deleted ${describeData(removed)} of context mode data.`, "info");
}

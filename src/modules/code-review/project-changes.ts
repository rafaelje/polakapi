import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { startWatchingProject } from "./api";
import { stringifyError } from "../../shared/errors";

const CHANGED_EVENT = "code-review:changed";

export type ProjectChangeListener = () => void;

const listeners = new Set<ProjectChangeListener>();

export function onProjectChanged(listener: ProjectChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function watchProjectChanges(projectPath: string): Promise<void> {
  await getCurrentWebviewWindow().listen(CHANGED_EVENT, () => {
    for (const listener of listeners) listener();
  });
  try {
    await startWatchingProject(projectPath);
  } catch (error) {
    console.warn(`Auto-refresh is off: ${stringifyError(error)}`);
  }
}

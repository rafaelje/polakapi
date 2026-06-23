import { open } from "@tauri-apps/plugin-dialog";

export interface PickProjectFolderOptions {
  defaultPath?: string;
}

/**
 * Opens the native folder picker via `@tauri-apps/plugin-dialog` and returns
 * the selected absolute path, or `null` if the user cancels.
 *
 * Centralizes the dialog options so tests can mock a single module.
 */
export async function pickProjectFolder(opts?: PickProjectFolderOptions): Promise<string | null> {
  const result = await open({
    directory: true as const,
    multiple: false as const,
    defaultPath: opts?.defaultPath,
    title: "Choose project folder",
  });
  return result;
}

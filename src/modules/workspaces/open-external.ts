import { invoke } from "../../shared/tauri/invoke";

/**
 * Thin typed wrappers around the `open_in_explorer` / `open_in_editor` Tauri
 * commands. Kept in a dedicated module so the project pane and bootstrap stay
 * decoupled from the invoke layer and the module is unit-testable in isolation.
 */

/** Opens `path` in the OS file manager (Finder / Explorer / xdg-open). */
export function revealFolder(path: string): Promise<void> {
  return invoke<void>("open_in_explorer", { path }, { errorMessage: "Failed to open folder" });
}

/**
 * Opens `path` in an editor. When `editor` is omitted, the backend probes the
 * fallback order (agy-ide → code) and uses the first binary found on PATH.
 */
export function openInEditor(path: string, editor?: string): Promise<void> {
  return invoke<void>(
    "open_in_editor",
    { path, editor: editor ?? null },
    { errorMessage: "Failed to open editor" },
  );
}

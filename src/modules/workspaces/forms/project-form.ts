import { promptModal, selectModal } from "../../../shared/ui/modal";
import { showToast } from "../../../shared/ui/toast";
import { pickProjectFolder } from "../path-picker";
import { formatPathError, validatePath } from "../path-validation";
import { compareByOrderThenName } from "../state/workspaces-reducer-helpers";
import type { Folder, FolderId, PathValidation, Project } from "../state/types";

/**
 * Result of a project-form flow. The `cancelled` discriminant captures the
 * user pressing Escape or closing the picker — distinct from a hard error so
 * callers do not surface a toast for the regular cancel path.
 */
export type ProjectFormResult =
  | { kind: "ok"; name: string; path: string; folderId?: FolderId }
  | { kind: "cancelled" }
  | { kind: "error"; validation: Extract<PathValidation, { ok: false }> };

const NO_FOLDER_VALUE = "";

export interface CreateProjectFormOptions {
  /** Pre-filled folder for the picker on subsequent runs (rare in create). */
  defaultPath?: string;
  /**
   * The target workspace's sidebar folders. When non-empty, the flow gains an
   * extra "which folder?" step after path validation and before the name
   * prompt. Skipped entirely when empty — no added friction for workspaces
   * that don't use folders.
   */
  folders?: Folder[];
  /** Pre-selects this folder in the picker (e.g. a folder's own "Add project…"). */
  initialFolderId?: FolderId;
}

export interface EditProjectFormOptions {
  project: Pick<Project, "name" | "path">;
}

/**
 * Drives the "create project" UX: native folder picker → fs validation →
 * name prompt (with basename pre-filled). The actual mutation belongs to the
 * caller — this module is pure I/O orchestration so it stays testable and
 * reusable from the controller, command palette, etc.
 */
export async function openCreateProjectForm(
  opts?: CreateProjectFormOptions,
): Promise<ProjectFormResult> {
  const path = await pickProjectFolder({ defaultPath: opts?.defaultPath });
  if (!path) return { kind: "cancelled" };

  const validation = await validatePath(path);
  if (!validation.ok) {
    showToast(formatPathError(validation), "error");
    return { kind: "error", validation };
  }

  let folderId: FolderId | undefined = opts?.initialFolderId;
  if (opts?.folders && opts.folders.length > 0) {
    const choice = await selectModal({
      title: "Add to folder",
      options: [
        { value: NO_FOLDER_VALUE, label: "No folder (workspace root)" },
        ...[...opts.folders]
          .sort(compareByOrderThenName)
          .map((f) => ({ value: f.id, label: f.name })),
      ],
      initialValue: opts.initialFolderId ?? NO_FOLDER_VALUE,
      confirmLabel: "Next",
    });
    if (choice === null) return { kind: "cancelled" };
    folderId = choice === NO_FOLDER_VALUE ? undefined : (choice as FolderId);
  }

  const defaultName = basename(path);
  const name = await promptModal({
    title: "Add project",
    message: path,
    placeholder: "Project name",
    initialValue: defaultName,
    confirmLabel: "Add",
  });
  if (name === null) return { kind: "cancelled" };
  const trimmed = name.trim();
  if (!trimmed) return { kind: "cancelled" };
  return { kind: "ok", name: trimmed, path, folderId };
}

/**
 * Drives the "change project path" UX: re-opens the picker pre-pointed at the
 * current folder, validates the new selection, but does not prompt for a new
 * name (rename has its own inline flow). Returns the validated absolute path.
 */
export async function openEditProjectPathForm(
  opts: EditProjectFormOptions,
): Promise<ProjectFormResult> {
  const path = await pickProjectFolder({ defaultPath: opts.project.path });
  if (!path) return { kind: "cancelled" };

  const validation = await validatePath(path);
  if (!validation.ok) {
    showToast(formatPathError(validation), "error");
    return { kind: "error", validation };
  }
  return { kind: "ok", name: opts.project.name, path };
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "Project";
}

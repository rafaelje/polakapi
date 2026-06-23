import { promptModal } from "../../shared/ui/modal";
import { showToast } from "../../shared/ui/toast";
import { pickProjectFolder } from "./path-picker";
import { formatPathError, validatePath } from "./path-validation";
import type { PathValidation, Project } from "./types";

/**
 * Result of a project-form flow. The `cancelled` discriminant captures the
 * user pressing Escape or closing the picker — distinct from a hard error so
 * callers do not surface a toast for the regular cancel path.
 */
export type ProjectFormResult =
  | { kind: "ok"; name: string; path: string }
  | { kind: "cancelled" }
  | { kind: "error"; validation: Extract<PathValidation, { ok: false }> };

export interface CreateProjectFormOptions {
  /** Pre-filled folder for the picker on subsequent runs (rare in create). */
  defaultPath?: string;
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
  return { kind: "ok", name: trimmed, path };
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

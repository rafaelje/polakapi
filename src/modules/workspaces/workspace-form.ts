import { promptModal } from "../../shared/ui/modal";

/**
 * Result of the workspace name form. `cancelled` covers Escape, empty input,
 * and the user dismissing the modal — callers treat all three identically.
 */
export type WorkspaceFormResult = { kind: "ok"; name: string } | { kind: "cancelled" };

export interface CreateWorkspaceFormOptions {
  initialValue?: string;
}

/**
 * Prompts the user for a workspace name via the in-app modal. The shared
 * `promptModal` already owns focus, keyboard handling and cleanup, so this
 * module only sanitizes the result.
 */
export async function openCreateWorkspaceForm(
  opts?: CreateWorkspaceFormOptions,
): Promise<WorkspaceFormResult> {
  const value = await promptModal({
    title: "New workspace",
    placeholder: "e.g. Personal",
    initialValue: opts?.initialValue,
    confirmLabel: "Create",
  });
  if (value === null) return { kind: "cancelled" };
  const trimmed = value.trim();
  if (!trimmed) return { kind: "cancelled" };
  return { kind: "ok", name: trimmed };
}
